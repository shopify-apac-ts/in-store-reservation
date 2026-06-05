import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { listUrl, releaseUrl } from "./config.js";

export default async () => {
  render(<Modal />, document.body);
};

/** 期限 ISO8601 を Asia/Tokyo の短い表記にする（失敗時は元文字列）。 */
function fmtExpiry(iso) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** 本人確認用（氏名 / メール / 電話）を 1 行にまとめる。 */
function contactLine(r) {
  return [r.email, r.customerPhone].filter(Boolean).join(" / ");
}

/** 取置き商品名（複数明細は「商品名 × 数量、…」で連結）。title 無しは除外。 */
function lineItemsLabel(r) {
  const items = (r.lineItems ?? []).filter((li) => li.title);
  if (items.length === 0) return "";
  return items.map((li) => `${li.title} × ${li.quantity}`).join("、");
}

/** カンマ連結文字列に値を追加（trim + 空除去 + 重複除去）。 */
function mergeCsv(existing, value) {
  const set = new Set(
    String(existing ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (value) set.add(String(value).trim());
  return [...set].join(",");
}

/** 予約を顧客（customerId 優先・無ければ customerName）でグループ化する。 */
function groupByCustomer(list) {
  const groups = new Map();
  for (const r of list) {
    const key = r.customerId || r.customerName || "__none__";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: r.customerName || "（顧客未設定）",
        items: [],
      });
    }
    groups.get(key).items.push(r);
  }
  return [...groups.values()];
}

/**
 * POS ホームの「取置き引取り」モーダル。
 *
 * フロー（複数予約の一括引取り対応）:
 *   1. listUrl("reserved") を Bearer(JWT) で取得し、引取り待ち予約を顧客ごとに一覧表示。
 *   2. スタッフが「引取り＆カートへ」を押す:
 *      a. POST /release で在庫を reserved -> available に戻す（既存ルート流用）。
 *      b. POS Cart API で明細を復元（addLineItem は数値 variant id）。
 *      c. カート属性 pickup_idem / pickup_reservation_no を「カンマ連結で累積」する
 *         （既存値を読んで追記）。複数予約を 1 カートに載せても全件が
 *         orders/create webhook で突合され completed 化される。
 *      d. 初回のみ POS カートの顧客を自動セット（数値 customer id）。
 *      e. 引取り済みは一覧から除去し、累計バナーに加算。一覧に留まり「続けて引取り」可能。
 *   3. 「閉じる（カートで決済）」で window.close() → レジ（カート）タブで一括決済。
 *
 * 注意:
 *   - モーダルを閉じるのは window.close()。現行 POS UI（統一 Preact）には
 *     shopify.action.dismiss() は無い。
 *   - 顧客情報は EC のログインアカウント由来（手入力なし）。
 *
 * 認証は shopify.session.getSessionToken() の Bearer。
 */
function Modal() {
  // loading | ready | error
  const [phase, setPhase] = useState("loading");
  const [error, setError] = useState("");
  const [reservations, setReservations] = useState([]);
  const [busyId, setBusyId] = useState(null); // 引取り処理中の draftId
  const [picked, setPicked] = useState([]); // 引取り済み {reservationNo, name, qty}
  const [customerSet, setCustomerSet] = useState(false); // カート顧客を自動セット済みか

  async function load() {
    setPhase("loading");
    setError("");
    try {
      const token = await shopify.session.getSessionToken();
      const res = await fetch(listUrl("reserved"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok && body.ok) {
        setReservations(Array.isArray(body.reservations) ? body.reservations : []);
        setPhase("ready");
      } else if (res.status === 401 || res.status === 403 || res.status === 410) {
        setPhase("error");
        setError("認証に失敗しました。アプリ権限を確認してください。");
      } else {
        setPhase("error");
        setError(`一覧の取得に失敗しました（${body.error ?? res.status}）。`);
      }
    } catch (e) {
      setPhase("error");
      setError("通信エラーが発生しました。ネットワークを確認してください。");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handlePickup(r) {
    setBusyId(r.draftId);
    setError("");
    try {
      const token = await shopify.session.getSessionToken();

      // (a) 在庫を reserved -> available に戻す（既存 /release ルート）。
      const res = await fetch(releaseUrl(r.draftId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      const body = await res.json().catch(() => ({}));

      if (!(res.ok && body.ok)) {
        if (res.status === 409) {
          setError(
            `この予約は引取りできない状態です（${body.status ?? "不明"}）。期限切れ／キャンセル済みの可能性があります。`,
          );
        } else if (res.status === 404) {
          setError("対象の取置き予約が見つかりませんでした。");
        } else if (res.status === 401 || res.status === 403) {
          setError("認証に失敗しました。アプリ権限を確認してください。");
        } else {
          setError(`引取り処理に失敗しました（${body.error ?? res.status}）。`);
        }
        setBusyId(null);
        return;
      }

      // (b) POS カートへ明細を復元。
      if (shopify.cart && typeof shopify.cart.addLineItem === "function") {
        for (const li of r.lineItems ?? []) {
          const variantNum = Number(li.variantId);
          if (!Number.isFinite(variantNum) || variantNum <= 0) continue;
          // 戻り値は line-item UUID（"" はオーバーセル警告のキャンセル等）。
          await shopify.cart.addLineItem(variantNum, li.quantity);
        }

        // (c) 予約キーを「カンマ連結で累積」（既存値に追記）。
        if (typeof shopify.cart.addCartProperties === "function") {
          const cur = shopify.cart.current?.value;
          const existing = cur?.properties ?? {};
          const props = {};
          if (r.idempotencyKey) {
            props.pickup_idem = mergeCsv(existing.pickup_idem, r.idempotencyKey);
          }
          if (r.reservationNo) {
            props.pickup_reservation_no = mergeCsv(
              existing.pickup_reservation_no,
              r.reservationNo,
            );
          }
          if (Object.keys(props).length > 0) {
            await shopify.cart.addCartProperties(props);
          }
        }

        // (d) 初回のみカート顧客を自動セット（数値 customer id 必須・非致命）。
        if (
          !customerSet &&
          r.customerId &&
          typeof shopify.cart.setCustomer === "function"
        ) {
          const cur = shopify.cart.current?.value;
          if (!cur?.customer) {
            const cid = Number(r.customerId);
            if (Number.isFinite(cid) && cid > 0) {
              try {
                await shopify.cart.setCustomer({ id: cid });
                setCustomerSet(true);
              } catch {
                // 顧客セット失敗は引取り継続（バナーで通知のみ）。
                setError(
                  "カートへの顧客自動セットに失敗しました。必要に応じて手動で設定してください。",
                );
              }
            }
          } else {
            setCustomerSet(true);
          }
        }
      }

      // (e) 引取り済みを一覧から除去 & 累計に加算。一覧に留まる。
      setReservations((cur) => cur.filter((x) => x.draftId !== r.draftId));
      setPicked((cur) => [
        ...cur,
        { reservationNo: r.reservationNo, name: r.name, qty: r.qty },
      ]);
      setBusyId(null);
    } catch (e) {
      setError("引取り処理中にエラーが発生しました。もう一度お試しください。");
      setBusyId(null);
    }
  }

  // 操作中の POS デバイスのロケーション（shopify.session.currentSession.locationId
  // は数値）。これに一致する取置きだけを表示し、他店舗（例: Hakuba 操作時の
  // Hakuba 以外）の予約は隠す。location が取得できない場合は安全側で全件表示。
  const currentLocationId = shopify?.session?.currentSession?.locationId;
  const visible =
    currentLocationId == null
      ? reservations
      : reservations.filter(
          (r) =>
            r.legacyLocationId != null &&
            String(r.legacyLocationId) === String(currentLocationId),
        );
  const hiddenCount = reservations.length - visible.length;
  const groups = groupByCustomer(visible);

  return (
    <s-page heading="取置き引取り">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            {error ? <s-banner tone="critical">{error}</s-banner> : null}

            {picked.length > 0 ? (
              <s-banner tone="success">
                {`${picked.length}件をカートに追加済み（受取番号 ${picked
                  .map((p) => p.reservationNo ?? "-")
                  .join(" / ")}）。カートタブで一括決済してください。`}
              </s-banner>
            ) : null}

            {phase === "loading" ? <s-text>読み込み中…</s-text> : null}

            {phase === "error" ? (
              <s-button variant="primary" onClick={load}>
                再読み込み
              </s-button>
            ) : null}

            {phase === "ready" && hiddenCount > 0 ? (
              <s-text tone="neutral">
                {`他ロケーションの取置き ${hiddenCount} 件はこの店舗では非表示です。`}
              </s-text>
            ) : null}

            {phase === "ready" && visible.length === 0 ? (
              <s-text tone="neutral">
                {picked.length > 0
                  ? "引取り待ちの取置きは残っていません。カートで決済してください。"
                  : hiddenCount > 0
                    ? "この店舗で引取り待ちの取置きはありません。"
                    : "引取り待ちの取置きはありません。"}
              </s-text>
            ) : null}

            {phase === "ready"
              ? groups.map((g) => (
                  <s-box key={g.key} padding="base">
                    <s-stack direction="block" gap="base">
                      <s-text type="strong">{`${g.name}（${g.items.length}件）`}</s-text>
                      {g.items.map((r) => (
                        <s-box key={r.draftId} padding="base">
                          <s-stack direction="block" gap="base">
                            <s-text>
                              {(r.reservationNo ?? r.name) +
                                " ／ " +
                                (r.locationName ?? "—")}
                            </s-text>
                            {lineItemsLabel(r) ? (
                              <s-text type="strong">{lineItemsLabel(r)}</s-text>
                            ) : null}
                            <s-text tone="neutral">
                              {`数量 ${r.qty ?? "—"} ・ 期限 ${fmtExpiry(r.expiresAt)}${r.isExpired ? "（期限切れ）" : ""}`}
                            </s-text>
                            {contactLine(r) ? (
                              <s-text tone="neutral">{contactLine(r)}</s-text>
                            ) : null}
                            <s-button
                              variant="primary"
                              disabled={busyId === r.draftId}
                              onClick={() => handlePickup(r)}
                            >
                              {busyId === r.draftId ? "処理中…" : "引取り＆カートへ"}
                            </s-button>
                          </s-stack>
                        </s-box>
                      ))}
                    </s-stack>
                  </s-box>
                ))
              : null}

            <s-button variant={picked.length > 0 ? "primary" : "secondary"} onClick={() => window.close()}>
              {picked.length > 0 ? "閉じる（カートで決済）" : "閉じる"}
            </s-button>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
