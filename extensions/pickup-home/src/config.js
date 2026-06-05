/**
 * アプリ backend のベース URL。
 *
 * POS UI 拡張にはアプリ URL を返す組み込み API が無いため、
 * `shopify.app.toml` の `application_url`（= `shopify app dev` のトンネル URL）と
 * 同じ値をここに持つ。トンネル URL が変わったらこの値も更新すること。
 */
export const APP_URL = "https://nobu-pickup-fqclg2.tunnel.shopifycloud.tech";

/** 引取り待ち（reserved）の取置き予約一覧を取得する URL。 */
export function listUrl(status = "reserved") {
  return `${APP_URL}/apps/pickup/reservations/list?status=${encodeURIComponent(status)}`;
}

/**
 * 引取り（release）エンドポイントの URL。
 * draftLegacyId は POS の Draft Order API / 一覧 API が返す legacy 数値 ID。
 */
export function releaseUrl(draftLegacyId) {
  return `${APP_URL}/apps/pickup/reservations/${draftLegacyId}/release`;
}
