import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getReservation, setStatus } from "../lib/pickup/draft.server";
import { releaseReservation } from "../lib/pickup/release.server";
import { TAG_BASE } from "../lib/pickup/constants";
import { UserError, GraphqlError } from "../lib/pickup/errors";

/**
 * POST /apps/pickup/reservations/:draftId/release
 *
 * POS UI Extension（pos.draft-order-details.action）からの「取置きを引取り」操作。
 * reserved 在庫を available に戻し（POS 決済の直前に必須）、ステータスを released にする。
 *
 * 認証: POS 拡張は `shopify.session.getSessionToken()` の JWT を
 *   `Authorization: Bearer <token>` で送る。`authenticate.admin(request)` が
 *   それを検証し token-exchange して admin クライアントを返す（App Proxy 署名ではない）。
 *
 * 冪等: 期限切れ sweep / 二重タップと競合しても、releaseInventory が
 *   @idempotent + clamp で no-op になる。既に released/completed なら 200 を返す。
 */

// POS 拡張は別オリジンの webview から叩くため CORS を許可する。
// 認証は Bearer トークンのみで Cookie を使わないため Origin: * で安全。
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

// CORS プリフライト（OPTIONS）は認証前に 204 で返す。
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
  }

  // POS セッショントークン（Bearer JWT）を検証 -> admin クライアント取得。
  const { admin } = await authenticate.admin(request);

  const draftId = params.draftId;
  if (!draftId || !/^\d+$/.test(draftId)) {
    return jsonResponse({ error: "invalid_id" }, { status: 400 });
  }
  const gid = `gid://shopify/DraftOrder/${draftId}`;

  try {
    const r = await getReservation(admin, gid);
    if (!r) {
      return jsonResponse({ error: "not_found" }, { status: 404 });
    }
    if (!r.tags.includes(TAG_BASE)) {
      return jsonResponse({ error: "not_a_pickup_reservation" }, { status: 422 });
    }

    // 既に引取り済み/完了済みなら冪等に成功扱い。
    if (r.status === "released" || r.status === "completed") {
      return jsonResponse({
        ok: true,
        alreadyReleased: true,
        status: r.status,
        reservationNo: r.reservationNo,
        name: r.name,
        legacyResourceId: r.legacyResourceId,
      });
    }

    // reserved 以外（expired/cancelled）は引取り対象外。
    if (r.status !== "reserved") {
      return jsonResponse(
        { ok: false, error: "not_releasable", status: r.status },
        { status: 409 },
      );
    }

    const { releasedQuantity } = await releaseReservation(admin, r, "release");
    await setStatus(admin, gid, "released");

    return jsonResponse({
      ok: true,
      status: "released",
      releasedQuantity,
      reservationNo: r.reservationNo,
      name: r.name,
      locationName: r.locationName,
      legacyResourceId: r.legacyResourceId,
    });
  } catch (e) {
    if (e instanceof UserError) {
      console.error(
        "[release] userErrors:",
        e.userErrors.map((u) => u.code ?? u.message).join(","),
      );
      return jsonResponse({ ok: false, error: "release_failed" }, { status: 422 });
    }
    if (e instanceof GraphqlError) {
      console.error("[release] graphql error");
      return jsonResponse({ ok: false, error: "graphql_error" }, { status: 502 });
    }
    console.error(
      "[release] error:",
      e instanceof Error ? e.message : "unknown",
    );
    return jsonResponse({ ok: false, error: "internal_error" }, { status: 500 });
  }
};
