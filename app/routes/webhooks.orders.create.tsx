import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { findByIdem, linkOrder, setStatus } from "../lib/pickup/draft.server";
import { releaseReservation } from "../lib/pickup/release.server";
import { ATTR } from "../lib/pickup/constants";

/**
 * orders/create webhook
 *
 * POS で取置き Draft Order が決済されると Order が作られる。Order の
 * note_attributes は元 Draft の customAttributes から引き継がれるため、
 * `pickup_idem` を読んで元の予約 Draft を特定し、completed にしたうえで、
 * その取置き記録（Draft）に対応する販売 Order を紐づける。
 *   ※ Draft（＝予約レコード）は完了後も削除せず残す。Admin の取置き一覧
 *     （完了タブ）はこの Draft を読むため、削除すると履歴が消えてしまう。
 *
 * 複数予約の一括決済: POS モーダルが複数の取置きを 1 カートにまとめると
 *   `pickup_idem` はカンマ連結（"keyA,keyB,…"）になる。これを分割し、各 idem を
 *   個別に completed 化する（1 件失敗しても他は継続。webhook は常に 200）。
 *
 * 異常系: release 漏れ（reserved のまま決済成功）を検知したら、
 *   在庫ドリフトを避けるため reserved を available に戻したうえで alert ログを出す。
 */

interface NoteAttribute {
  name?: string;
  value?: string;
}

/** 1 件の idem を completed 化し、販売 Order を紐づける（release 漏れは在庫を戻してから）。 */
async function completeOne(
  admin: NonNullable<Awaited<ReturnType<typeof authenticate.webhook>>["admin"]>,
  idemKey: string,
  orderGid: string | null,
  shop: string,
  topic: string,
): Promise<void> {
  const reservation = await findByIdem(admin, idemKey);
  if (!reservation) {
    // 既に完了処理が走り下書きを削除済み（webhook 再配信など）か、取置き由来でない。
    // どちらも何もしないのが正しい（冪等）。
    console.log(`[${topic}] ${shop}: 対象の取置きなし（完了済み/対象外） idem=${idemKey}`);
    return;
  }

  // release 漏れ（reserved のまま決済成功）→ 在庫を戻してから completed にする。
  if (reservation.status === "reserved") {
    console.error(
      `[${topic}] ${shop}: ALERT release漏れ検知 reservationNo=${reservation.reservationNo} idem=${idemKey} — reserved在庫を戻します`,
    );
    try {
      await releaseReservation(admin, reservation, "release");
    } catch (releaseErr) {
      console.error(
        `[${topic}] ${shop}: 在庫戻し失敗 reservationNo=${reservation.reservationNo}:`,
        releaseErr instanceof Error ? releaseErr.message : "unknown",
      );
    }
  }

  // 既に completed なら setStatus は冪等（同じタグの付け直し）。
  if (reservation.status !== "completed") {
    await setStatus(admin, reservation.id, "completed");
    console.log(
      `[${topic}] ${shop}: 取置き完了 reservationNo=${reservation.reservationNo} idem=${idemKey}`,
    );
  }

  // 取置き記録（Draft）は削除せず残し、対応する販売 Order を紐づける。
  // これで Admin の完了タブに履歴が残り、各記録から注文を辿れる。
  // 既に同じ Order が紐づいていれば API を呼ばない（再配信に対して冪等）。
  if (orderGid && reservation.orderId !== orderGid) {
    await linkOrder(admin, reservation, orderGid);
    console.log(
      `[${topic}] ${shop}: 注文紐付け reservationNo=${reservation.reservationNo} idem=${idemKey}`,
    );
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  // app/uninstalled 直後など admin が無いケースは何もしない。
  if (!admin) {
    return new Response();
  }

  const order = payload as {
    admin_graphql_api_id?: string;
    note_attributes?: NoteAttribute[];
  };

  const rawIdem = (order.note_attributes ?? []).find(
    (a) => a.name === ATTR.idem,
  )?.value;

  // 取置き由来でない通常注文は無視する。
  if (!rawIdem) {
    return new Response();
  }

  // 紐づける販売 Order の GID（取置き Draft の customAttribute に保存する）。
  const orderGid = order.admin_graphql_api_id ?? null;

  // 複数予約の一括決済はカンマ連結。分割 → trim → 空除去 → 重複除去。
  const idemKeys = [
    ...new Set(
      rawIdem
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    ),
  ];

  // 各予約を個別に completed 化（1 件失敗しても他は継続）。
  for (const idemKey of idemKeys) {
    try {
      await completeOne(admin, idemKey, orderGid, shop, topic);
    } catch (e) {
      console.error(
        `[${topic}] ${shop}: error idem=${idemKey}:`,
        e instanceof Error ? e.message : "unknown",
      );
      // webhook は 200 を返して再試行ループを避ける（処理は冪等なので次回 sweep 等で回収可）。
    }
  }

  return new Response();
};
