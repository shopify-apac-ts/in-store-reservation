/**
 * 店舗取置き（in-store pickup reservation）アプリの共有定数。
 *
 * 設計上の要点（docs/store-pickup-reservation-plan.md 参照）:
 * - 専用 DB を持たず、Draft Order 自体を「予約レコード」として扱う。
 * - 状態は Draft Order の tags で遷移させ、メタ情報は customAttributes に持つ。
 * - 在庫は inventoryMoveQuantities で available <-> reserved を行き来させる。
 *
 * NOTE: サーバ専用モジュール。POS 拡張 / Liquid からは import しない。
 */

import { createHash } from "node:crypto";

/** すべての取置き Draft Order に付くベースタグ。一覧抽出に使う。 */
export const TAG_BASE = "pickup-reservation";

/** 予約ステータス。タグ `pickup-status:<status>` として保存する。 */
export const STATUSES = [
  "reserved",
  "released",
  "completed",
  "expired",
  "cancelled",
] as const;
export type PickupStatus = (typeof STATUSES)[number];

export const STATUS_TAG_PREFIX = "pickup-status:";
export const LOCATION_TAG_PREFIX = "pickup-location:";
export const IDEM_TAG_PREFIX = "pickup-idem:";

export const statusTag = (s: PickupStatus) => `${STATUS_TAG_PREFIX}${s}`;
export const locationTag = (legacyLocationId: string) =>
  `${LOCATION_TAG_PREFIX}${legacyLocationId}`;

/**
 * idempotencyKey をタグに埋め込むための固定長ハッシュ。
 *
 * Shopify のタグは **最大 40 文字**。idempotencyKey は任意長（UUID 等）で、
 * `pickup-idem:` (12) + 36 文字 UUID = 48 文字となりタグ作成が
 * "Tag exceeds the maximum length of 40 characters" で失敗する。
 * そこで衝突しにくい固定長（sha1 先頭 16hex = 64bit）に変換して格納する。
 * 完全な idempotencyKey は customAttribute(ATTR.idem) に保持するため、
 * このハッシュは「重複検出のための索引」としてのみ用いる。
 */
export const idemHash = (idempotencyKey: string): string =>
  createHash("sha1").update(idempotencyKey).digest("hex").slice(0, 16);

export const idemTag = (idempotencyKey: string) =>
  `${IDEM_TAG_PREFIX}${idemHash(idempotencyKey)}`;

/** すべてのステータスタグ（retag 時に一括除去するため）。 */
export const ALL_STATUS_TAGS = STATUSES.map(statusTag);

/** Draft Order customAttributes のキー。 */
export const ATTR = {
  reservationNo: "pickup_reservation_no",
  locationId: "pickup_location_id",
  locationName: "pickup_location_name",
  expiresAt: "pickup_expires_at",
  qty: "pickup_qty",
  variantId: "pickup_variant_id",
  // 顧客の数値 legacyResourceId。purchasingEntity での下書き紐付けが
  // （new customer accounts 等で）失敗しても、グルーピング / POS カート顧客
  // 自動セットを継続できるよう、必ず customAttribute としても保持する。
  customerId: "pickup_customer_id",
  customerName: "pickup_customer_name",
  customerPhone: "pickup_customer_phone",
  // idempotencyKey も customAttribute として持たせる。Draft 完了時に
  // Order の note_attributes へ引き継がれ、orders/create webhook が
  // findByIdem で元の予約 Draft を再特定できるようにするため。
  idem: "pickup_idem",
  // 引取り完了時に POS が作った販売 Order の GID を紐づける。
  // 取置き記録（Draft）は完了後も削除せず残し、この属性で対応注文を辿る。
  orderId: "pickup_order_id",
} as const;

/** inventoryMoveQuantities で取得する数量状態の名前。 */
export const QUANTITY_NAMES = [
  "available",
  "reserved",
  "on_hand",
  "committed",
] as const;

/**
 * inventoryMoveQuantities の reason。
 * Shopify 在庫調整理由の正規セットに含まれる値を用いる。
 */
export const RESERVE_REASON = "reservation_created";
export const RELEASE_REASON = "reservation_deleted";

/** shop metafield（対象ロケーション / 取置き保持時間）。 */
export const SHOP_METAFIELD_NAMESPACE = "pickup";
export const MF_ENABLED_LOCATIONS_KEY = "enabled_locations";
export const MF_HOLD_HOURS_KEY = "hold_hours";

/** Admin 設定が未保存のときのデフォルト保持時間（時間）。 */
export const DEFAULT_HOLD_HOURS = 72;

/**
 * inventoryMoveQuantities の @idempotent キー。
 * 同一 Draft + アクションでは常に同じ値になり、二重実行を no-op にする。
 */
export const moveIdemKey = (
  draftLegacyId: string,
  action: "reserve" | "release" | "expire",
) => `${draftLegacyId}:${action}`;

/** 在庫調整の監査用 referenceDocumentUri。 */
export const referenceDocumentUri = (
  draftLegacyId: string,
  action: "reserve" | "release" | "expire",
) => `gid://store-pickup-app/Reservation/${draftLegacyId}/${action}`;

/** location GID から legacy 数値 ID を取り出す（タグ用）。 */
export const legacyIdFromGid = (gid: string): string => {
  const m = gid.match(/(\d+)(?:\?.*)?$/);
  return m ? m[1] : gid;
};

/** legacy 数値 ID を location GID に戻す。 */
export const locationGidFromLegacy = (legacy: string): string =>
  legacy.startsWith("gid://")
    ? legacy
    : `gid://shopify/Location/${legacy}`;
