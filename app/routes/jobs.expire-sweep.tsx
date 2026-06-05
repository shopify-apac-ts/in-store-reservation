import type { ActionFunctionArgs } from "@remix-run/node";
import { timingSafeEqual } from "node:crypto";
import { unauthenticated } from "../shopify.server";
import { runExpireSweep } from "../lib/pickup/sweep.server";

/**
 * POST /jobs/expire-sweep
 *
 * 期限切れの取置き予約を回収する。Shopify Flow（Scheduled time -> Send HTTP request）
 * または Admin の「期限切れを今すぐ処理」ボタンから叩かれる。
 *
 * セッションを持たない呼び出しなので unauthenticated.admin(shop) でオフライン
 * トークンを使う。共有シークレットで保護する（App Proxy / Admin 認証は使えない）。
 *
 * 処理: pickup-status:reserved のうち expiresAt < now を抽出 ->
 *   releaseReservation(expire) で reserved->available 戻し -> retag expired。
 *   Draft は履歴として残す（= 予約レコード。Flow が expired タグ起点で通知）。
 */

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function extractSecret(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const hdr = request.headers.get("x-pickup-sweep-secret");
  return hdr?.trim() || null;
}

async function resolveShop(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  let shop = url.searchParams.get("shop");

  if (!shop) {
    const ct = request.headers.get("content-type") ?? "";
    try {
      if (ct.includes("application/json")) {
        const body = (await request.json()) as { shop?: unknown };
        if (typeof body.shop === "string") shop = body.shop;
      } else if (
        ct.includes("application/x-www-form-urlencoded") ||
        ct.includes("multipart/form-data")
      ) {
        const form = await request.formData();
        const v = form.get("shop");
        if (typeof v === "string") shop = v;
      }
    } catch {
      // ボディ無し/壊れている場合は env フォールバックへ。
    }
  }

  shop = shop?.trim() || process.env.PICKUP_SHOP?.trim() || null;
  if (!shop) return null;
  return SHOP_RE.test(shop) ? shop : null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
  }

  // ---- 共有シークレット検証 ----
  const expected = process.env.PICKUP_EXPIRE_SWEEP_SECRET?.trim();
  if (!expected) {
    console.error("[expire-sweep] PICKUP_EXPIRE_SWEEP_SECRET is not set");
    return jsonResponse({ error: "not_configured" }, { status: 503 });
  }
  const provided = extractSecret(request);
  if (!provided || !safeEqual(provided, expected)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  // ---- 対象ストア解決 ----
  const shop = await resolveShop(request);
  if (!shop) {
    return jsonResponse(
      { error: "invalid_shop", message: "valid myshopify shop is required" },
      { status: 400 },
    );
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (e) {
    console.error(
      "[expire-sweep] could not get offline admin for shop:",
      e instanceof Error ? e.message : "unknown",
    );
    return jsonResponse({ error: "no_session_for_shop" }, { status: 401 });
  }

  // ---- 期限切れ回収（共通コア） ----
  try {
    const { swept, releasedQuantity, passes, failed } =
      await runExpireSweep(admin);
    return jsonResponse({
      ok: true,
      shop,
      swept,
      releasedQuantity,
      passes,
      failed: failed.length,
    });
  } catch (e) {
    console.error(
      "[expire-sweep] sweep aborted:",
      e instanceof Error ? e.message : "unknown",
    );
    return jsonResponse(
      { ok: false, shop, error: "sweep_failed" },
      { status: 500 },
    );
  }
};
