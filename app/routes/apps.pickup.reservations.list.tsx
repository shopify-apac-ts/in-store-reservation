import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { listReservations, type Reservation } from "../lib/pickup/draft.server";
import { legacyIdFromGid, type PickupStatus, STATUSES } from "../lib/pickup/constants";
import { GraphqlError } from "../lib/pickup/errors";

/**
 * GET /apps/pickup/reservations/list?status=reserved
 *
 * 専用 POS UI Extension（pos.home.modal）の「取置き引取り」一覧で使う。
 * 既定では reserved（引取り待ち）の取置き予約を返す。
 *
 * 認証: /release と同じく POS の `shopify.session.getSessionToken()` JWT を
 *   `Authorization: Bearer <token>` で受け、`authenticate.admin(request)` が
 *   検証 + token-exchange する（App Proxy 署名ではない。トンネル直叩き）。
 *
 * PII 方針: ログには予約番号 / draft id / location のみ。氏名・メール・電話は
 *   レスポンス本文には含めるが（店舗スタッフが本人確認に使う）ログには出さない。
 */

// POS 拡張は別オリジン webview から叩くため CORS を許可（Cookie 不使用・Bearer のみ）。
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

/** POS Cart API（addLineItem は数値 variant id を要求）向けの軽量 DTO。 */
function toDto(r: Reservation) {
  return {
    draftId: r.legacyResourceId, // /release のパスに使う legacy 数値 id
    name: r.name,
    reservationNo: r.reservationNo,
    status: r.status,
    locationName: r.locationName,
    locationId: r.locationId,
    // POS 現在ロケーション（shopify.session.currentSession.locationId は数値）と
    // 突合して、操作中の店舗の取置きだけをモーダルに表示するために使う。
    legacyLocationId: r.legacyLocationId,
    expiresAt: r.expiresAt,
    isExpired: r.isExpired,
    qty: r.qty,
    // orders/create webhook が pickup_idem で突合できるよう、カート属性に載せる値。
    idempotencyKey: r.idempotencyKey,
    // 顧客グルーピング & POS カート顧客自動セット用（数値 customer id）。
    customerId: r.customerId,
    // 本人確認用（スタッフ表示）。
    customerName: r.customerName,
    email: r.email,
    customerPhone: r.customerPhone,
    note: r.note,
    // カート復元用。variantId は POS Cart API 用に数値文字列へ変換。
    lineItems: r.lineItems
      .filter((li) => li.variantId)
      .map((li) => ({
        variantId: legacyIdFromGid(li.variantId as string),
        quantity: li.quantity,
        title: li.title ?? null,
      })),
  };
}

function parseStatus(raw: string | null): PickupStatus {
  if (raw && (STATUSES as readonly string[]).includes(raw)) {
    return raw as PickupStatus;
  }
  return "reserved";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
  }

  // POS セッショントークン（Bearer JWT）を検証 -> admin クライアント取得。
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const status = parseStatus(url.searchParams.get("status"));

  try {
    const { reservations, hasNextPage } = await listReservations(admin, {
      status,
      first: 50,
    });
    return jsonResponse({
      ok: true,
      status,
      count: reservations.length,
      hasNextPage,
      reservations: reservations.map(toDto),
    });
  } catch (e) {
    if (e instanceof GraphqlError) {
      console.error("[reservations.list] graphql error");
      return jsonResponse({ ok: false, error: "graphql_error" }, { status: 502 });
    }
    console.error(
      "[reservations.list] error:",
      e instanceof Error ? e.message : "unknown",
    );
    return jsonResponse({ ok: false, error: "internal_error" }, { status: 500 });
  }
};

// CORS プリフライト（OPTIONS）が action 側にルーティングされた場合にも 204 を返す。
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
};
