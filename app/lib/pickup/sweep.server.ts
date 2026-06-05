import type { AdminGraphqlClient } from "./admin.server";
import { listReservations, setStatus } from "./draft.server";
import { releaseReservation } from "./release.server";

/**
 * 期限切れ取置きの回収ロジック（共通コア）。
 *
 * HTTP エンドポイント（/jobs/expire-sweep, Flow から起動）と
 * Admin 設定画面の「期限切れを今すぐ処理」ボタンの両方から呼ぶ。
 *
 * retag すると pickup-status:reserved フィルタから外れるため、毎パス
 * 先頭ページを取り直す。期限切れが無くなれば収束。MAX_PASSES で安全弁。
 */

const MAX_PASSES = 20;
const PAGE_SIZE = 50;

export interface SweepResult {
  swept: number;
  releasedQuantity: number;
  passes: number;
  failed: string[];
}

export async function runExpireSweep(
  admin: AdminGraphqlClient,
): Promise<SweepResult> {
  let swept = 0;
  let releasedQuantity = 0;
  let passes = 0;
  const failed: string[] = [];

  while (passes < MAX_PASSES) {
    const { reservations } = await listReservations(admin, {
      status: "reserved",
      first: PAGE_SIZE,
    });

    const now = Date.now();
    const expired = reservations.filter(
      (r) => r.expiresAt != null && Date.parse(r.expiresAt) < now,
    );
    if (expired.length === 0) break;

    for (const r of expired) {
      try {
        const { releasedQuantity: q } = await releaseReservation(
          admin,
          r,
          "expire",
        );
        await setStatus(admin, r.id, "expired");
        swept += 1;
        releasedQuantity += q;
      } catch (perItem) {
        // 1 件失敗しても次へ。reservationNo のみログ（PII を出さない）。
        failed.push(r.reservationNo ?? r.legacyResourceId);
        console.error(
          "[expire-sweep] failed for",
          r.reservationNo ?? r.legacyResourceId,
          perItem instanceof Error ? perItem.message : "unknown",
        );
      }
    }
    passes += 1;
  }

  return { swept, releasedQuantity, passes, failed };
}
