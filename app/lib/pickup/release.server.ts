import type { AdminGraphqlClient } from "./admin.server";
import { getVariantInventory } from "./locations.server";
import { releaseInventory } from "./inventory.server";
import type { Reservation } from "./draft.server";

/**
 * 予約の在庫ホールド（reserved）をロケーションへ戻す共通処理。
 * 引取り(release) / 期限切れ(expire) / キャンセル の各経路で使い回す。
 *
 * - line item ごとに現在の reserved/available を取り直してから戻すため、
 *   二重実行・期限切れとの競合に強い（releaseInventory が clamp + 寛容処理）。
 * - 在庫戻しのみを担当。ステータスタグ遷移・Draft 削除は呼び出し側の責務。
 */
export async function releaseReservation(
  admin: AdminGraphqlClient,
  reservation: Reservation,
  action: "release" | "expire",
): Promise<{ releasedQuantity: number; lineItemsProcessed: number }> {
  if (!reservation.locationId) {
    return { releasedQuantity: 0, lineItemsProcessed: 0 };
  }

  let releasedQuantity = 0;
  let lineItemsProcessed = 0;

  for (const li of reservation.lineItems) {
    if (!li.variantId || !li.inventoryItemId || li.quantity <= 0) continue;

    const inv = await getVariantInventory(admin, li.variantId);
    const level = inv
      ? inv.levels.find((l) => l.locationId === reservation.locationId)
      : null;
    // ロケーションに在庫レベルが無い = 戻す reserved も無い。スキップ。
    if (!level) continue;

    const result = await releaseInventory(admin, {
      inventoryItemId: li.inventoryItemId,
      locationId: reservation.locationId,
      quantity: li.quantity,
      currentReserved: level.reserved,
      currentAvailable: level.available,
      draftLegacyId: reservation.legacyResourceId,
      action,
    });

    releasedQuantity += result.movedQuantity;
    lineItemsProcessed += 1;
  }

  return { releasedQuantity, lineItemsProcessed };
}
