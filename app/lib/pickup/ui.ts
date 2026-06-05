import type { PickupStatus } from "./constants";

/**
 * Admin UI 用の表示ヘルパ（client/server 両用、サーバ専用 import なし）。
 */

export const STATUS_LABEL: Record<PickupStatus, string> = {
  reserved: "取置き中",
  released: "引取り対応中",
  completed: "完了",
  expired: "期限切れ",
  cancelled: "キャンセル",
};

/** Polaris Badge の tone（"new" 等の文字列リテラル）。 */
export type BadgeTone =
  | "info"
  | "success"
  | "attention"
  | "warning"
  | "critical"
  | undefined;

export const STATUS_TONE: Record<PickupStatus, BadgeTone> = {
  reserved: "attention",
  released: "info",
  completed: "success",
  expired: "warning",
  cancelled: undefined,
};

export function statusLabel(s: string | null): string {
  if (!s) return "—";
  return STATUS_LABEL[s as PickupStatus] ?? s;
}

export function statusTone(s: string | null): BadgeTone {
  if (!s) return undefined;
  return STATUS_TONE[s as PickupStatus];
}

/** ISO8601 を JST の読みやすい文字列に整形する。 */
export function formatJst(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** DraftOrder の legacy 数値 ID から Admin ルート用パスを作る。 */
export function reservationPath(legacyResourceId: string): string {
  return `/app/reservations/${legacyResourceId}`;
}
