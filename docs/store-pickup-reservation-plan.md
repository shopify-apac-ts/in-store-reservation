# 店舗在庫の取置き Custom App 実装プラン（軽量 Shopify ネイティブ版）

## Context（なぜ作るか）

`docs/store-pickup-reservation-app-spec.md` に既存の詳細設計がある。目的は **EC で決済なしの店舗取置き申請 → 指定店舗の在庫を available→reserved にロック → 来店時に POS で引取り＋決済 → 期限切れは自動で reserved→available に戻す** を 1 本の Custom App で成立させること。

本プランはその設計を **ライブストアで実際に検証**し、ユーザー決定に沿って **軽量・Shopify ネイティブ・ローカル実行** に最適化した実装計画である。

> 当初は `dev-nobu-beer-store.myshopify.com`（開発ストア）で検証したが、開発ストアは POS 機能に制限があるため（スマートグリッド編集不可など）、ターゲットストアを **`nobu-beer-store-2.myshopify.com`** に移行した。アプリ（client_id 同一）は再利用。

### ライブ検証で確定した事実（このストア）
- 接続 OK。プラン = **Shopify Plus**（dev）/ TZ = Asia/Tokyo / 通貨 = **JPY**。
- 稼働ロケーション **4 件**（実 GID）:
  - Tokyo … `gid://shopify/Location/77963395244`
  - DormyInn Kyoto … `gid://shopify/Location/77963493548`
  - Hakuba … `gid://shopify/Location/76904497324`
  - San Diego … `gid://shopify/Location/77017317548`
- 商品はビール（在庫追跡あり）。`reserved` 状態はクエリ可能（現状すべて 0）。マルチロケーション在庫の例: **Hakuba Black**（Hakuba 1300 + San Diego 200）、**Buddha's Hand**（Hakuba + DormyInn Kyoto）。→ 複数店舗デモに好適。
- **最新 API スキーマで検証済み（✅ VALID）**:
  - `inventoryMoveQuantities ... @idempotent(key:)` + `changeFromQuantity`（CAS）… 2026-01 以降サポート。`available→reserved` 移動の公式例あり。
  - `draftOrderCreate`（必要スコープに **`write_quick_sale` が追加**で必要と判明）。
  - `productVariant.inventoryItem.inventoryLevels(...).quantities(names:[...])`。
  - POS ターゲット `pos.draft-order-details.action.menu-item.render` + `pos.draft-order-details.action.render` 実在。
- `devx tunnel <port> --permanent` 利用可（永続 https トンネル）。`shopify app dev --tunnel-url=<url>` でカスタムトンネル接続可。Node v24.15.0。

### ユーザー決定事項
1. **スコープ**: フル E2E デモ（EC + バックエンド + Admin + POS 拡張）。
2. **状態管理**: **軽量 Shopify ネイティブ**。Draft Order 自体を予約レコードにし、専用予約 DB は作らない。期限切れは **Shopify Flow** のスケジュールトリガで処理。
3. **実行環境**: **この MacBook 上**で実行。トンネルは **`devx tunnel`** を使用。
4. **対象ロケーション**: **Admin 設定で選択式（全店デフォルト ON）**。

---

## アーキテクチャ（軽量版の要点）

- **専用予約テーブルは持たない。** Draft Order が「予約レコード」そのもの。状態はタグで遷移させる。
  - tags: `pickup-reservation`, `pickup-status:reserved|released|completed|expired|cancelled`, `pickup-location:<locId>`, `pickup-idem:<idempotencyKey>`
  - customAttributes: `pickup_reservation_no`(R-xxxx), `pickup_location_id`, `pickup_location_name`, `pickup_expires_at`(ISO8601), `pickup_qty`
  - note: 人間可読「Tokyo店 取置き / 期限 2026-06-06 18:00 / 受取番号 R-00123」
- **テンプレ同梱の SQLite は OAuth セッション保管のみに使用**（予約データは入れない）。実質 DB レス。
- **冪等性**: 予約作成は `draftOrders(query:"tag:'pickup-idem:<key>'")` で既存検索 → あれば返す。在庫移動は `@idempotent(key:"<draftLegacyId>:reserve|release|expire")`。
- **対象ロケーション設定**は **shop metafield**（`pickup.enabled_locations`, type `list.location_reference` もしくは JSON）に保存。EC エンドポイントと Admin 設定が同じ metafield を読む。DB 不要。
- **API バージョン**: 最新 stable（CLI デフォルト）。spec の `2026-04` 表記は最新へ読み替え。
- **release/expire の在庫戻し処理は共通関数 `releaseInventory(draftOrder)` に集約**して使い回す。

### 状態遷移（在庫レジャー）
```
EC申請  : available --(inventoryMoveQuantities)--> reserved   （ロック）
引取り  : reserved --(inventoryMoveQuantities)--> available    （release。POS決済の直前に必須）
POS決済 : available --(Shopify標準)--> committed --> fulfilled
期限切れ: reserved --(inventoryMoveQuantities)--> available    （expire）
```
※ release を省くと reserved に在庫が残留し on_hand がドリフトする。引取り時は必ず先に reserved→available へ戻す。

### Admin スコープ（`shopify.app.toml`）
`read_products, read_inventory, write_inventory, read_locations, read_draft_orders, write_draft_orders, write_quick_sale, read_orders, write_orders, read_customers, write_customers`

---

## ビルド計画（フェーズ順 / 代表ファイル）

土台は `shopify app init`（Remix テンプレ）。以下は新規/編集する代表パス。POS 拡張は **必ず CLI で scaffold**（手書き禁止）。

### Phase 0 — 足場とトンネル
- `shopify app init` → アプリ生成、ターゲットストア（現 `nobu-beer-store-2`）に紐付け。
- `shopify.app.toml`: 上記スコープ、App Proxy（`subpath_prefix=apps`, `subpath=pickup`, `url=<tunnel>`）、`application_url`/redirect を tunnel URL に。
- トンネル: `devx tunnel 3000 --permanent --name nobu-pickup` → 得た URL を toml に設定 → `shopify app dev --tunnel-url=<url>`。
- GraphQL ラッパーを独立モジュール化: `app/lib/pickup/inventory.server.ts`(`reserveAtLocation`/`releaseInventory`), `app/lib/pickup/draft.server.ts`(`createPickupDraft`/`findByIdem`/`retag`), `app/lib/pickup/locations.server.ts`(`enabledLocationsForVariant`)。

### Phase 1 — 予約作成 + 期限切れ（バックエンド先行）
- `app/routes/apps.pickup.locations.tsx`（App Proxy GET）: variantId→inventoryItem→各ロケ available 取得 → enabled ∩ available>0 を返す。HMAC 署名検証必須。
- `app/routes/apps.pickup.reservations.tsx`（App Proxy POST）: §「STEP2 処理順」を厳守。Draft 作成成功→在庫移動失敗時は **`draftOrderDelete` でロールバック**。
- `app/routes/jobs.expire-sweep.tsx`（POST, 共有シークレット/HMAC 保護）: `tag:pickup-status:reserved` の Draft を取得 → `pickup_expires_at < now` を抽出 → `releaseInventory` → retag `expired` → `draftOrderDelete` → キャンセル通知。
- 通知は **`draftOrderInvoiceSend` を使わない**（pay-now 請求リンクは店頭決済モデルに不適切）。Flow のタグ起点メール、または app からの確認メールで「受取番号・期限・店舗住所」を送る。

### Phase 2 — EC ウィジェット（Theme App Extension）
- `extensions/pickup-form/blocks/store_pickup_form.liquid`: PDP 用 app block。`selected_or_first_available_variant.id` 取得 → `/apps/pickup/locations` → `<select>` + 数量/氏名/メール/電話 → `/apps/pickup/reservations`。在庫不足 409 を「在庫が変動しました」と表示。
- dev テーマでブロックを有効化し、ビール商品 PDP に配置。

### Phase 3 — Admin アプリ（Polaris + App Bridge）
- `app/routes/app._index.tsx`: 予約一覧（`draftOrders(query:"tag:'pickup-reservation'")` をステータスタグで集計/フィルタ）。
- `app/routes/app.reservations.$id.tsx`: 詳細 + 期限延長（customAttribute 更新）/ 手動キャンセル（release+retag `cancelled`+delete）/ 再通知。
- `app/routes/app.settings.tsx`: 対象ロケーション ON/OFF（shop metafield 書込）、デフォルト取置き時間、メール文面。**「期限切れを今すぐ処理」ボタン**（=expire-sweep 手動キック。トンネル/PC 非常駐デモの確実な手段）。

### Phase 4 — POS UI Extension（引取り）
- `shopify app generate extension --template=pos_action` で scaffold。
- ターゲット: `pos.draft-order-details.action.menu-item.render`（ボタン「取置きを引取り」）+ `pos.draft-order-details.action.render`（モーダル）。
- 動作: ボタン → `POST /apps/pickup/reservations/<draftLegacyId>/release`（reserved→available + retag `released`）→ 成功後に Draft Order を POS カートへロード → スタッフが通常決済。
- Webhook `orders/create`: 取置き由来注文を検知し retag `completed`。release 漏れのまま決済成功を検知したら alert。
- フォールバック（フルスコープなので併設）: Admin の「Release & open in POS」ボタン（同一 `/release` エンドポイント）。

### Phase 5 — 期限切れの自動化（Flow）
- Shopify Flow: **Scheduled time** トリガ（毎時）→ **Send HTTP request** で `/jobs/expire-sweep` を叩く。ロジックは app 側に集約。
- 注意: トンネル/MacBook が稼働中のときのみ Flow→app が届く。非常駐デモでは Admin の手動 sweep ボタンを正とする。

---

## 例外処理・エッジケース（spec 準拠 + 軽量版補足）
- available 不足 → 409 `in_stock_changed`。CAS 失敗 → 1 回再取得して再試行 → なお失敗で 409。
- Draft 作成成功 → Move 失敗 → `draftOrderDelete` ロールバック。
- 同一 `pickup-idem:<key>` → 既存 Draft を返す（200）。
- 期限切れ vs POS release の競合 → 先に走った方が成功、もう片方は `@idempotent` で no-op。
- release 漏れで決済成功 → `orders/create` で検知 → alert（手動で reserved→available）。
- `app/uninstalled` → 全 `pickup-status:reserved` を release + retag `expired`。
- `customers/redact` webhook 実装（PII 最小、ログに PII を出さない）。

## セキュリティ
- App Proxy は `signature` を HMAC-SHA256 検証。Webhook は `X-Shopify-Hmac-Sha256` 検証。`/jobs/expire-sweep` は共有シークレット/HMAC。トークンはローカル `.env`（コミット禁止）。

---

## 検証（このストアでの E2E）
1. `devx tunnel 3000 --permanent --name nobu-pickup` → URL を toml に反映 → `shopify app dev --tunnel-url=<url>`。
2. dev テーマで Theme App Extension を有効化し、**Hakuba Black**（Hakuba+San Diego の複数店舗在庫）PDP にブロック配置。
3. PDP フォームから Tokyo もしくは Hakuba に 1 個取置き → `shopify store execute` で前後の在庫をクエリし **reserved +1 / available −1** を確認。
4. POS シミュレータで該当 Draft Order を開く → 「取置きを引取り」→ reserved→available 戻し + Draft がカートにロード → 決済完了 → `orders/create` → ステータス `completed`。
5. 期限切れ: 期限 ~2 分後の予約を作成 → Admin「期限切れを今すぐ処理」（or Flow）→ available 復元・Draft 削除/`expired` タグ・通知を確認。
6. 並行性: 同一 variant に在庫を絞って並行予約 N 本 → CAS により成功＋409 の振り分けを確認。

検証用 GraphQL（最新スキーマで ✅ 検証済み）は `app/lib/pickup/*.server.ts` に格納。`shopify store execute --query-file ... --json` で随時単体疎通可能。

---

## 未確定 / 実装時に確認したい軽微点
- 確認・キャンセル通知の最終手段（Flow メール vs app メール）。デフォルトは Flow タグ起点メールを推奨。
- デフォルト取置き時間（例: 72h or 24h）。Admin 設定で可変、初期値は要指定。
- 受取番号フォーマット（`R-` 連番 vs Draft 名流用）。連番カウンタを持たないため Draft 名/ハッシュ流用を推奨。
