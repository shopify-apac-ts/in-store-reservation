# Shopify「店舗在庫の取置き」Custom App 設計指南書

宛先: Claude（実装担当 LLM） / 人間レビュー: Nobu Hayashi (Shopify)
バージョン: v1 (2026-06-01)
関連図: <https://arch-diagrams.quick.shopify.io/d/d79ad40b-e5a5-45c3-a4c5-bd4b6f8b17ec>

---

## 0. このドキュメントの読み方

これは Claude に「Shopify Custom App を 1 本まるごと書いてもらう」ための実装指示書である。要件・アーキテクチャ・API・データモデル・例外処理まで一通り定義してある。Claude は本書を出発点に、足りない判断が必要な箇所は明示的に質問してから実装に入ること。判断材料がそろっている箇所は本書通りに実装してよい。

すべての Shopify API 引用は `shopify.dev` の公式ドキュメントに準拠している。実装中に仕様変更が見つかった場合は実装をいったん停止し、人間に確認すること。

---

## 1. ゴール / 非ゴール

### 1.1 ゴール

Shopify EC + Shopify POS を使い、以下の業務フローを 1 本の Custom App で成立させる。

1. お客様が EC 上で「この店舗の在庫を取り置きしたい」を申請する（決済なし）
2. App が指定された店舗の `available` 在庫を、その場で `reserved` に移して在庫ロックする
3. お客様が店舗に来店し、Shopify POS で取置き分を引取り＋その場で決済する
4. お客様が現れず期限切れになったら、App が在庫を自動で `reserved → available` に戻して取置きをキャンセル、お客様に通知する

### 1.2 非ゴール

- EC 上での決済（決済はあくまで店頭 POS）
- 配送、在庫の店舗間移送、複数店舗にまたがる取置き
- Shopify Plus の Order Routing を使った位置決定（本設計は Plus でなくても動く構成）
- 顧客側ログイン機能の新規構築（既存の Customer Accounts に乗るか、メール受信のみで完結）

---

## 2. アーキテクチャ概観

### 2.1 構成要素

| レイヤ | 実体 | 役割 |
|---|---|---|
| Storefront | Theme App Extension (App Block) | 商品詳細ページに「店舗取置き」ウィジェットを差し込む |
| Storefront API | App Proxy (`/apps/<prefix>/*`) | 公開エンドポイント。署名検証してバックエンドに転送 |
| Backend | Node.js / Remix (Shopify CLI 標準テンプレ) | 在庫照会・予約作成・期限切れ処理・Webhook 受信 |
| Admin Surface | Embedded Admin App (Polaris + App Bridge) | 予約一覧 / 手動キャンセル / 期限延長 |
| POS Surface | POS UI Extension (任意・推奨) | 「取置きを引取り」アクションで release + カート展開 |
| DB | Postgres (本番) / SQLite (dev) via Prisma | 予約レコード・冪等性キー・スケジューラ用キュー |
| Scheduler | node-cron もしくは外部 (Cloud Scheduler / GitHub Actions) | 期限切れ予約のスキャン |
| 通知 | Shopify Email API / Shopify Flow + 任意の SMTP | 受取案内・期限切れ通知 |

### 2.2 推奨スタック

- `npm init @shopify/app@latest` で生成される Remix テンプレートをベースにする
- Node.js 20 LTS, TypeScript, Prisma, Tailwind は任意
- Shopify Admin API バージョンは `2026-04` (latest) を採用
- GraphQL クライアントは `@shopify/admin-api-client`
- App 種別: **Custom App**（特定マーチャント向け）。Public App として App Store に出さない前提

---

## 3. データモデル

### 3.1 App DB スキーマ (Prisma 表記)

```prisma
model Reservation {
  id                String   @id @default(cuid())
  shopDomain        String
  draftOrderId      String   @unique          // gid://shopify/DraftOrder/...
  draftOrderName    String                     // "D1" など (人間可読)
  locationId        String                     // gid://shopify/Location/...
  locationName      String                     // 銀座店 等
  customerEmail     String
  customerName      String
  customerPhone     String?
  lineItems         Json                       // [{variantId, inventoryItemId, quantity}]
  status            ReservationStatus          // RESERVED / RELEASED / COMPLETED / EXPIRED / CANCELLED
  expiresAt         DateTime
  reservedAt        DateTime  @default(now())
  releasedAt        DateTime?
  completedAt       DateTime?
  expiredAt         DateTime?
  idempotencyKey    String    @unique          // 重複予約防止
  notes             String?
  // 在庫ロックの監査用
  inventoryAdjustmentGroupId String?           // 最後の move mutation の group ID
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  @@index([shopDomain, status, expiresAt])
}

enum ReservationStatus {
  RESERVED   // 在庫を reserved にロック済み、未引取
  RELEASED   // 引取り直前に reserved → available に戻した (POS で決済処理中)
  COMPLETED  // POS 決済まで完了
  EXPIRED    // 期限切れで自動キャンセル
  CANCELLED  // 手動キャンセル
}
```

### 3.2 Shopify 側に付けるタグ／メタ情報

Draft Order に必ず以下を付けて作成すること。POS 側・運用側でひと目で識別できる。

| 場所 | キー | 値の例 |
|---|---|---|
| `tags` | `pickup-reservation` | （タグ単独） |
| `tags` | `pickup-location:gid://shopify/Location/12345` | locationId をタグに展開 |
| `note` | (フリーテキスト) | 「銀座店 取置き / 期限 2026-06-04 18:00 / 受取番号 R-00123」 |
| `customAttributes` | `pickup_reservation_id` | App DB の Reservation.id |
| `customAttributes` | `pickup_location_id` | locationId (再掲) |
| `customAttributes` | `pickup_expires_at` | ISO8601 |

### 3.3 `referenceDocumentUri` 規約

`inventoryMoveQuantities` を呼ぶときの `referenceDocumentUri` は、後から監査できるように以下の URI スキームを使う：

```
gid://store-pickup-app/Reservation/<reservation_id>/<action>
```

`<action>` は `reserve` / `release` / `expire` のいずれか。

---

## 4. Shopify Admin API スコープ

`shopify.app.toml` の `scopes` に以下を列挙する。

- `read_locations`
- `read_products`
- `read_inventory`, `write_inventory`
- `read_draft_orders`, `write_draft_orders`
- `read_orders`, `write_orders` （Webhook 受信用）
- `read_customers`, `write_customers`

POS UI Extension を作る場合は別途 extension マニフェストで POS targets を宣言（[POS UI Extensions](https://shopify.dev/docs/apps/build/pos)）。

---

## 5. 各ステップの実装詳細

### 5.1 STEP 1 — Storefront ブロック（店舗ドロップダウン）

**配置**: Theme App Extension の `blocks/store_pickup_form.liquid`。商品詳細テンプレートに app block として追加。

**ブロック責務**:

1. 現在の `product.selected_or_first_available_variant.id` を取得
2. App Proxy 経由で `GET /apps/<prefix>/locations?variantId=<gid>` を叩き、在庫が `available > 0` のロケーション一覧をもらう
3. `<select>` に詰めて、数量・氏名・メール・電話のフォームを描画
4. submit で `POST /apps/<prefix>/reservations` （JSON）

**App Proxy エンドポイント仕様**:

```
GET /apps/<prefix>/locations
  Query: variantId=gid://shopify/ProductVariant/12345  (or numeric ID)
  Resp: 200 {
    locations: [
      { id: "gid://shopify/Location/111", name: "銀座店",
        address: { city: "Tokyo", ... }, available: 4 },
      ...
    ]
  }
```

実装ロジック (バックエンド):

```ts
// 1. variantId から inventoryItemId を引く
const { productVariant } = await admin.graphql(`
  query($id: ID!) {
    productVariant(id: $id) {
      inventoryItem { id }
    }
  }`, { variables: { id: variantId }});

// 2. inventoryItem.inventoryLevels で全ロケーションの available を取得
const { inventoryItem } = await admin.graphql(`
  query($id: ID!) {
    inventoryItem(id: $id) {
      inventoryLevels(first: 50) {
        edges {
          node {
            location { id name address { city province country } }
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }`, { variables: { id: inventoryItemId }});

// 3. available > 0 のロケーションのみフィルタして返す
```

参照:
- App Proxy: <https://shopify.dev/docs/apps/build/online-store/display-dynamic-data> （App Proxy の節）
- Theme App Extensions: <https://shopify.dev/docs/apps/build/online-store/theme-app-extensions>
- `inventoryItem` query: <https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryItem>
- `InventoryLevel`: <https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel>

**App Proxy 署名検証**: Shopify が付ける `?signature=` パラメータを HMAC-SHA256 で検証してから処理に入ること。テンプレートには既に middleware が入っている。

### 5.2 STEP 2 — 予約作成 (`POST /apps/<prefix>/reservations`)

**入力**:

```json
{
  "variantId": "gid://shopify/ProductVariant/12345",
  "quantity": 1,
  "locationId": "gid://shopify/Location/111",
  "customer": { "email": "...", "name": "...", "phone": "..." },
  "expiresInHours": 72,
  "idempotencyKey": "<client-generated UUID>"
}
```

**処理 (順序厳守)**:

```
1) DB: 同じ idempotencyKey の Reservation があれば、それを返す（idempotent）
2) Admin GraphQL:
   query: inventoryItem(...) で対象ロケーションの available を取得
   → available < quantity ならエラー (409 Conflict, "in_stock_changed")
3) Admin GraphQL: draftOrderCreate(input: {
     email, phone,
     customAttributes: [
       {key: "pickup_reservation_id", value: reservation.id},
       {key: "pickup_location_id", value: locationId},
       {key: "pickup_expires_at", value: expiresAt.toISOString()}
     ],
     lineItems: [{variantId, quantity}],
     note: "銀座店 取置き / 期限 ... / 受取番号 R-...",
     tags: ["pickup-reservation", "pickup-location:gid://..."]
     // reserveInventoryUntil は使わない（位置指定できないため）
   })
4) DB: Reservation を RESERVED で作成 (draftOrderId, locationId, expiresAt)
5) Admin GraphQL: inventoryMoveQuantities(input: {
     reason: "other",
     referenceDocumentUri: "gid://store-pickup-app/Reservation/<id>/reserve",
     changes: [{
       inventoryItemId,
       quantity,
       from: { locationId, name: "available",
               ledgerDocumentUri: null,
               changeFromQuantity: <現在のavailable> },  // CAS で安全に
       to:   { locationId, name: "reserved",
               ledgerDocumentUri: null,
               changeFromQuantity: <現在のreserved> }
     }]
   }, idempotencyKey: <reservation.id + ":reserve">)
6) ↑が失敗したら draftOrderDelete でロールバック、DB の Reservation を削除
7) Admin GraphQL: draftOrderInvoiceSend で受取案内メール
   (テンプレに「受取番号」「期限」「店舗住所」を記載)
8) 200 OK { reservationId, draftOrderName, expiresAt }
```

**重要な実装上のルール**:

- 3 と 5 は同じ DB トランザクションには入れられない（Shopify 側）。**5 が失敗したら 3 をロールバック (`draftOrderDelete`) するコードパスを必ず持つ**こと。
- `inventoryMoveQuantities` の `changeFromQuantity` (CAS) を必ず指定する。並行予約での over-reserve を防ぐ。失敗時は再試行 (1 回まで)、それでも失敗したら 409 を返す。
- 冪等性: `idempotencyKey` を `inventoryMoveQuantities` の `@idempotent` directive にも渡す（2026-01 以降サポート）。詳細は <https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryMoveQuantities> の例参照。

参照:
- `draftOrderCreate`: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCreate>
- `inventoryMoveQuantities`: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryMoveQuantities>
- `InventoryMoveQuantityTerminalInput`: <https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryMoveQuantityTerminalInput>
- `draftOrderInvoiceSend`: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderInvoiceSend>
- 在庫ステート定義: <https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps>

### 5.3 STEP 3 — 来店・引取り＋決済

**運用ルートは 2 系統**:

**(A) 推奨: POS UI Extension「取置き引取り」ボタン**

POS UI Extensions で `pos.cart-detail.action.menu-item.render` または `pos.draft-order-details.action.render` のターゲットを実装。スタッフが取置きを開いて「引取り」を押すと、内部で:

```
1) App backend に POST /apps/<prefix>/reservations/<id>/release
2) backend: inventoryMoveQuantities(reserved → available @ locationId)
   referenceDocumentUri = "gid://store-pickup-app/Reservation/<id>/release"
   DB: status = RELEASED, releasedAt = now()
3) POS extension が成功を受け、Draft Order を POS Cart にロード
4) スタッフが通常通り POS で決済
5) 決済完了で orders/create webhook が App に飛ぶ → Reservation を COMPLETED に
```

POS API:
- <https://shopify.dev/docs/api/pos-ui-extensions/apis/draft-order-api>
- <https://shopify.dev/docs/api/pos-ui-extensions/apis/cart-api>
- <https://shopify.dev/docs/apps/build/pos>

**(B) フォールバック: Admin App から release**

POS Extension を後回しにしたい場合、Embedded Admin App に「Release & open in POS」ボタンを置く。スタッフは Admin App でボタンを押してから POS で Draft Order を呼び出す。実装的にはエンドポイントは同じ `POST /reservations/<id>/release`。

**Webhook ハンドラ** (`orders/create`):

```
1) order.customAttributes に pickup_reservation_id があるか確認
2) あれば、対応する Reservation を COMPLETED に更新 (completedAt = now)
3) 万一 RESERVED のまま完了している (= release ステップ漏れ) を検知したら
   alerting に流す（手動で在庫整合性チェック）
```

### 5.4 STEP 4 — 期限切れ自動キャンセル

**スケジューラ**: 5 分間隔で以下を実行する worker を 1 本走らせる。

```
const expired = await db.reservation.findMany({
  where: { status: 'RESERVED', expiresAt: { lt: new Date() }, shopDomain }
});

for (const r of expired) {
  await releaseInventory(r);          // inventoryMoveQuantities reserved → available
  await admin.graphql(`
    mutation($id: ID!) {
      draftOrderDelete(input: {id: $id}) { deletedId userErrors { field message } }
    }`, { variables: { id: r.draftOrderId }});
  await db.reservation.update({ where: {id: r.id}, data: {status: 'EXPIRED', expiredAt: new Date()}});
  await sendCancellationEmail(r);     // Shopify Email API or own SMTP
}
```

`releaseInventory` は STEP 3 の release ロジックと同一関数を使い回す。

参照:
- `draftOrderDelete`: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderDelete>

**ホスティング選択肢**:

- バックエンドを Fly.io / Render / Cloud Run に置く場合: コンテナ内で `node-cron` を回す
- サーバーレスにする場合: GCP Cloud Scheduler → HTTPS endpoint
- Shopify Flow の `Schedule` trigger でも可（ただし複雑な条件分岐は App 側に寄せる）

---

## 6. Admin App (Embedded) の最小要件

Polaris + App Bridge で以下のページを実装：

1. `/app` — 予約一覧 (Reservation テーブル, status / location / expires_at でフィルタ)
2. `/app/reservations/:id` — 詳細＋アクション
   - 期限延長 (`expiresAt` 更新)
   - 手動キャンセル (`Reservation.status = CANCELLED` にして release + draft delete)
   - 顧客への再通知メール
3. `/app/settings` — デフォルト取置き期間、対象ロケーション、メールテンプレ

---

## 7. 例外処理・エッジケース

| ケース | 挙動 |
|---|---|
| 予約時 `available` 不足 | 409 を返し、「在庫が変動しました」とフォームに表示 |
| `inventoryMoveQuantities` の CAS 失敗 | 1 回だけ再取得して再試行、それでも失敗なら 409 |
| Draft 作成成功 → Move 失敗 | `draftOrderDelete` でロールバック |
| 同一 idempotencyKey が来る | DB から既存 Reservation を返して 200 |
| 期限切れ直前に POS で release | release が先に走れば成功。Scheduler が先なら EXPIRED で 410 を POS extension が表示 |
| 顧客が POS で商品も追加して買う | OK。Draft Order に追加ライン投入は POS が処理。在庫は available から減る |
| POS で release し忘れて決済成功 | Webhook `orders/create` で検知して alerting。手動で `inventoryMoveQuantities (reserved → available)` を発行する |
| Custom App アンインストール | Webhook `app/uninstalled` で全 RESERVED を `EXPIRED` 化＋在庫を全 release する |
| アプリ DB と Shopify の不整合 | 日次の reconciliation job: Shopify の reserved 在庫 と App DB の RESERVED 合計を突合してアラート |

---

## 8. テスト計画

### 8.1 単体テスト

- 予約作成: 在庫十分・在庫不足・並行予約 (CAS) の 3 ケース
- Release: 通常・既に release 済み (冪等)
- Expire: 期限超過の検出・release + delete の連携
- Webhook: 正常・署名不正・冪等再送

### 8.2 統合テスト

- Shopify Dev Store でフル E2E:
  1. Theme App Extension をテストテーマに有効化
  2. PDP からフォーム送信
  3. Admin の 在庫タブで Reserved が増えていることを確認
  4. POS シミュレータで Draft Order を呼び出して決済
  5. Admin でステータスが COMPLETED に
- 期限切れケース:
  1. 期限 1 分後の予約を作る
  2. Scheduler を手動キック
  3. 在庫が available に戻り、Draft Order が消えていることを確認

### 8.3 ロード

- 同一商品に対して並行予約 10 本 → 在庫 5 個 → 5 件成功・5 件 409 を確認

---

## 9. セキュリティ・コンプライアンス

- App Proxy: 必ず `signature` を HMAC 検証
- Webhook: 必ず `X-Shopify-Hmac-Sha256` を HMAC 検証
- Admin API トークンは AWS Secrets Manager / GCP Secret Manager に保管
- 顧客の氏名・メール・電話は最小限を DB に保持。GDPR/個人情報法対応の削除エンドポイントを用意 (`customers/redact` webhook 実装)
- ログには PII を出さない（idempotencyKey, reservation id, location id のみ）

---

## 10. リリース計画

1. **Phase 0 (1〜2 日)**: Shopify CLI で Custom App プロジェクト初期化、Dev Store 連携、最小 GraphQL クライアントの疎通確認
2. **Phase 1 (3〜5 日)**: Step 2 (予約作成) と Step 4 (期限切れ Scheduler) のバックエンドを実装＋テスト
3. **Phase 2 (3〜5 日)**: Theme App Extension + App Proxy 経由の Step 1 を実装し、E2E で予約まで通す
4. **Phase 3 (3〜5 日)**: Admin App (Polaris) で予約一覧／手動キャンセル
5. **Phase 4 (任意, 3〜5 日)**: POS UI Extension で release ＆ カート展開
6. **Phase 5**: パイロット店舗 1 で 2 週間運用 → 問題洗い出し → 全店展開

---

## 11. Claude への明示的な指示

- 本書を読んだら、まず「不明点リスト」を返してから実装に入ること。具体的には:
  - Shopify Plan (Plus か否か)
  - 対象ロケーション数
  - 対象商品数 / 取置き想定件数 / 期限デフォルト
  - メール送信手段 (Shopify Email API / SendGrid / Shopify Flow)
  - ホスティング先 (Fly.io / Render / Cloud Run / 社内 PaaS)
- 実装は次の順序で進めること:
  1. `shopify.app.toml` と Prisma schema を先に固める
  2. GraphQL 操作のラッパー関数（`reserveAtLocation`, `releaseAtLocation`, `createPickupDraft` 等）を独立モジュールに切る
  3. ステップ単位で結合テストを書きながら積み上げる
- 仕様未確定箇所を勝手に決めて実装しないこと。必ず確認を取る。
- Shopify API のバージョンが本書 (`2026-04`) と異なる場合、最新で動作確認した上で本書の URL を新バージョンに差し替えてレビューに上げる。
- すべての DB 書込・API 呼出は冪等性を担保する。`idempotencyKey` を一貫して使う。
- ロールバック（特に Draft 作成成功 → Move 失敗時の `draftOrderDelete`）を実装し忘れない。

---

## 12. 引用元（実装時に必ず参照）

- Apps in inventory management (在庫ステートの定義): <https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps>
- `inventoryProperties` query: <https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryProperties>
- `inventoryItem` query: <https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryItem>
- `InventoryLevel` object: <https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel>
- `locations` query: <https://shopify.dev/docs/api/admin-graphql/latest/queries/locations>
- `inventoryMoveQuantities` mutation: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryMoveQuantities>
- `InventoryMoveQuantityChange`: <https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryMoveQuantityChange>
- `InventoryMoveQuantityTerminalInput`: <https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryMoveQuantityTerminalInput>
- `inventoryAdjustQuantities` mutation: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryAdjustQuantities>
- `DraftOrderInput`: <https://shopify.dev/docs/api/admin-graphql/latest/input-objects/DraftOrderInput>
- `DraftOrder` object: <https://shopify.dev/docs/api/admin-graphql/latest/objects/DraftOrder>
- `draftOrderCreate`: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCreate>
- `draftOrderUpdate`: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderUpdate>
- `draftOrderDelete`: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderDelete>
- `draftOrderComplete`: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderComplete>
- `draftOrderInvoiceSend`: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderInvoiceSend>
- POS UI Extensions overview: <https://shopify.dev/docs/apps/build/pos>
- POS UI Extensions — Draft Order API: <https://shopify.dev/docs/api/pos-ui-extensions/apis/draft-order-api>
- POS UI Extensions — Cart API: <https://shopify.dev/docs/api/pos-ui-extensions/apis/cart-api>
- Theme App Extensions: <https://shopify.dev/docs/apps/build/online-store/theme-app-extensions>

---

(EOF)
