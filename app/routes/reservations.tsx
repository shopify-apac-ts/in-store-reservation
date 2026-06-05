import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  getShopConfig,
  getVariantInventory,
  type VariantInventory,
} from "../lib/pickup/locations.server";
import {
  createPickupDraft,
  deleteDraft,
  findByIdem,
} from "../lib/pickup/draft.server";
import { reserveAtLocation } from "../lib/pickup/inventory.server";
import { locationGidFromLegacy } from "../lib/pickup/constants";
import {
  GraphqlError,
  InsufficientInventoryError,
  InventoryConflictError,
  UserError,
} from "../lib/pickup/errors";

/**
 * App Proxy POST
 *   ストアフロント URL : /apps/pickup/reservations
 *   アプリ受信パス     : /reservations   ← Shopify が /apps/pickup を剥がして転送（ゆえに reservations.tsx）
 *
 * 店舗取置き申請（決済なし）。docs の STEP2 処理順を厳守:
 *   1. 冪等性チェック（同一 idempotencyKey の既存予約があれば返す）
 *   2. 指定ロケーションの available を確認（不足なら 409）
 *   3. draftOrderCreate（= 予約レコード）
 *   4-5. inventoryMoveQuantities で available -> reserved（CAS + @idempotent）
 *   6. 在庫移動が失敗したら draftOrderDelete でロールバック
 *   7. 通知（reserved タグを起点に Shopify Flow が送信。ここでは行わない）
 *   8. 200 OK
 *
 * 署名(HMAC)検証は authenticate.public.appProxy が自動で行う。
 */

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

interface ReservationInput {
  variantId: string; // GID
  quantity: number;
  locationId: string; // GID
  idempotencyKey: string;
  customerId: string; // 顧客 GID（App Proxy 署名済み logged_in_customer_id 由来）
}

async function parseBody(request: Request): Promise<Record<string, string>> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const raw = (await request.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v != null) out[k] = String(v);
    }
    return out;
  }
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function pick(body: Record<string, string>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = body[k];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return null;
}

function normalizeVariantId(raw: string): string | null {
  if (raw.startsWith("gid://shopify/ProductVariant/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  return null;
}

function normalizeLocationId(raw: string): string | null {
  if (raw.startsWith("gid://shopify/Location/")) return raw;
  if (/^\d+$/.test(raw)) return locationGidFromLegacy(raw);
  return null;
}

function levelFor(inv: VariantInventory, locationId: string) {
  return inv.levels.find((l) => l.locationId === locationId) ?? null;
}

function locationEnabled(
  enabledLocationIds: string[] | null,
  locationId: string,
): boolean {
  // null = 未設定 = 全店対象
  return enabledLocationIds ? enabledLocationIds.includes(locationId) : true;
}

function summarize(reservation: {
  reservationNo: string | null;
  name: string;
  locationName: string | null;
  expiresAt: string | null;
  qty: number | null;
  status: string | null;
}) {
  return {
    reservationNo: reservation.reservationNo,
    draftName: reservation.name,
    locationName: reservation.locationName,
    expiresAt: reservation.expiresAt,
    quantity: reservation.qty,
    status: reservation.status,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
  }

  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  // ---- ログイン顧客限定 ----
  // logged_in_customer_id は App Proxy 署名(HMAC)で保護されるためサーバ側で信用できる。
  // クライアントの body から来る顧客情報は一切信用しない。
  const loggedInCustomerId = new URL(request.url).searchParams.get(
    "logged_in_customer_id",
  );
  if (!loggedInCustomerId || !/^\d+$/.test(loggedInCustomerId)) {
    return jsonResponse(
      {
        error: "login_required",
        message: "取置きにはログインが必要です。",
      },
      { status: 401 },
    );
  }
  const customerGid = `gid://shopify/Customer/${loggedInCustomerId}`;

  // ---- 入力パース & バリデーション ----
  let body: Record<string, string>;
  try {
    body = await parseBody(request);
  } catch {
    return jsonResponse({ error: "invalid_body" }, { status: 400 });
  }

  const variantRaw = pick(body, "variantId", "variant_id");
  const locationRaw = pick(body, "locationId", "location_id");
  const qtyRaw = pick(body, "quantity", "qty");
  const idempotencyKey = pick(body, "idempotencyKey", "idempotency_key");

  if (!variantRaw || !locationRaw || !qtyRaw || !idempotencyKey) {
    return jsonResponse(
      {
        error: "missing_fields",
        message: "variantId, locationId, quantity, idempotencyKey are required",
      },
      { status: 400 },
    );
  }

  const variantId = normalizeVariantId(variantRaw);
  const locationId = normalizeLocationId(locationRaw);
  const quantity = Number.parseInt(qtyRaw, 10);

  if (!variantId || !locationId) {
    return jsonResponse({ error: "invalid_ids" }, { status: 400 });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return jsonResponse(
      { error: "invalid_quantity", message: "quantity must be 1..999" },
      { status: 400 },
    );
  }

  const input: ReservationInput = {
    variantId,
    quantity,
    locationId,
    idempotencyKey,
    customerId: customerGid,
  };

  try {
    // ---- STEP 1: 冪等性 ----
    const existing = await findByIdem(admin, input.idempotencyKey);
    if (existing) {
      return jsonResponse(
        { ok: true, idempotent: true, reservation: summarize(existing) },
        { status: 200 },
      );
    }

    // ---- STEP 2: 在庫・ロケーション確認 ----
    const [config, inv] = await Promise.all([
      getShopConfig(admin),
      getVariantInventory(admin, input.variantId),
    ]);

    if (!inv) {
      return jsonResponse({ error: "variant_not_found" }, { status: 404 });
    }
    if (!inv.tracked) {
      return jsonResponse(
        { error: "not_tracked", message: "inventory is not tracked" },
        { status: 422 },
      );
    }
    if (!locationEnabled(config.enabledLocationIds, input.locationId)) {
      return jsonResponse(
        { error: "location_not_enabled" },
        { status: 422 },
      );
    }

    const level = levelFor(inv, input.locationId);
    if (!level || !level.isActive) {
      return jsonResponse(
        { error: "location_unavailable" },
        { status: 422 },
      );
    }
    if (level.available < input.quantity) {
      return jsonResponse(
        {
          error: "in_stock_changed",
          message: "在庫が変動しました。数量をご確認ください。",
          available: level.available,
        },
        { status: 409 },
      );
    }

    // ---- STEP 3: Draft Order 作成（= 予約レコード）----
    const expiresAtIso = new Date(
      Date.now() + config.holdHours * 60 * 60 * 1000,
    ).toISOString();

    const reservation = await createPickupDraft(admin, {
      variantId: input.variantId,
      quantity: input.quantity,
      locationId: input.locationId,
      locationName: level.name,
      expiresAtIso,
      idempotencyKey: input.idempotencyKey,
      customerId: input.customerId,
    });

    // ---- STEP 4-5: available -> reserved（CAS + @idempotent）----
    const inventoryItemId = inv.inventoryItemId;
    try {
      await reserveAtLocation(admin, {
        inventoryItemId,
        locationId: input.locationId,
        quantity: input.quantity,
        draftLegacyId: reservation.legacyResourceId,
        expected: { available: level.available, reserved: level.reserved },
        refetch: async () => {
          const fresh = await getVariantInventory(admin, input.variantId);
          const lvl = fresh ? levelFor(fresh, input.locationId) : null;
          if (!lvl) throw new InventoryConflictError("level disappeared");
          if (lvl.available < input.quantity) {
            throw new InsufficientInventoryError(lvl.available, input.quantity);
          }
          return { available: lvl.available, reserved: lvl.reserved };
        },
      });
    } catch (moveErr) {
      // ---- STEP 6: ロールバック ----
      await deleteDraft(admin, reservation.id).catch((delErr) => {
        console.error(
          "[pickup/reservations] rollback deleteDraft failed:",
          delErr instanceof Error ? delErr.message : "unknown",
        );
      });

      if (moveErr instanceof InsufficientInventoryError) {
        return jsonResponse(
          {
            error: "in_stock_changed",
            message: "在庫が変動しました。数量をご確認ください。",
            available: moveErr.available,
          },
          { status: 409 },
        );
      }
      if (moveErr instanceof InventoryConflictError) {
        return jsonResponse(
          {
            error: "inventory_conflict",
            message: "在庫が変動しました。もう一度お試しください。",
          },
          { status: 409 },
        );
      }
      throw moveErr;
    }

    // ---- STEP 7: 通知は Flow（reserved タグ起点）に委譲 ----
    // ---- STEP 8: 成功 ----
    return jsonResponse(
      { ok: true, idempotent: false, reservation: summarize(reservation) },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof UserError) {
      console.error(
        "[pickup/reservations] userErrors:",
        e.userErrors.map((u) => u.code ?? u.message).join(","),
      );
      // サーバログが取れない環境向けの自己診断: draftOrderCreate の userError は
      // Shopify のバリデーション文言（非 PII）なのでレスポンス本文に含める。
      const details = e.userErrors.map((u) => ({
        field: u.field ?? null,
        code: u.code ?? null,
        message: u.message,
      }));
      return jsonResponse({ error: "operation_failed", details }, { status: 422 });
    }
    if (e instanceof GraphqlError) {
      console.error("[pickup/reservations] graphql error");
      return jsonResponse({ error: "graphql_error" }, { status: 502 });
    }
    console.error(
      "[pickup/reservations] error:",
      e instanceof Error ? e.message : "unknown",
    );
    return jsonResponse({ error: "internal_error" }, { status: 500 });
  }
};
