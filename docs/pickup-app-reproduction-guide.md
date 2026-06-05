# Shopify で店舗取置き（in-store pickup reservation）アプリをどう作るか — 再現ガイド

> このドキュメントの目的: **別の開発者（人間でも AI でも）がこれ一本を読めば、同等の「店舗取置きアプリ」をゼロから再現できる**こと。設計の中核思想・データモデル・処理フロー・全コンポーネントの実装・ステージング運用ノウハウ・落とし穴を、実コードの逐語引用とともに凝縮する。
>
> 対象アプリは Shopify Custom App（Remix + TypeScript）。EC（オンラインストア）で **決済なし**の店舗取置きを申し込み、在庫を `available → reserved` にロックし、来店時に POS で `reserved → available` に戻して店頭決済、期限切れは自動で戻す、という一連の業務を実現する。すべての Shopify API は **2026-04** に統一。

---

## 0. TL;DR / これは何か

**業務フロー（4 ステップ）:**

1. **EC で取置き申請（決済なし）** — ログイン顧客が商品ページ（PDP）で「受取店舗」と「数量」を選んで申し込む。
2. **在庫ロック** — サーバが選択ロケーションの在庫を `available → reserved` に移動（`inventoryMoveQuantities`）。`on_hand` は動かさない。
3. **来店・POS で引取り＋店頭決済** — POS のホームタイル「取置き引取り」から、その店舗の引取り待ちを一覧表示。スタッフが「引取り＆カートへ」を押すと `reserved → available` に戻し、POS カートに明細を復元。複数の取置きを 1 カートにまとめて一括決済できる。
4. **完了化** — 決済で Order が作られると `orders/create` webhook が発火し、元の取置き記録を `completed` にして販売 Order を紐づける。期限切れ分は cron / Flow から `reserved → available` に自動回収。

**最重要の設計原則:**

- **Draft Order そのものが「予約レコード」。** 予約専用の DB テーブルは持たない。1 件の取置き = 1 件の Draft Order。
- **専用 DB は無い。** Prisma/SQLite には Shopify OAuth セッションを保存する `Session` モデルだけが存在する（予約テーブルは無い）。
- **状態 = tags / メタ = customAttributes / 在庫 = inventoryMoveQuantities。** 状態遷移は Draft Order のタグ、付帯情報は customAttributes、在庫は `available ↔ reserved` の移動で表現する。
- **顧客は署名済み `logged_in_customer_id` だけを信用する。** クライアントから送られる顧客情報は一切信用しない（App Proxy の HMAC 署名で保護された値のみ採用）。

---

## 1. 全体構成とコンポーネント

### 1-1. 俯瞰図（ASCII）

```
                         ┌──────────────────────────────────────────────┐
                         │            Shopify プラットフォーム             │
                         │  Draft Orders / Inventory / Customers / Flow   │
                         │  Orders / Metafields / Webhooks                │
                         └──────────────────────────────────────────────┘
                              ▲              ▲                 ▲
                  Admin GraphQL│  Admin GraphQL│      webhook(orders/create)
                  (2026-04)    │  (2026-04)    │      (HMAC)  │
                              │              │                 │
   ┌───────────────┐   App   │   ┌──────────┴───────────┐     │
   │ EC テーマ拡張  │  Proxy  │   │   Remix バックエンド   │◀────┘
   │ pickup-form    │─────────┼──▶│  @shopify/shopify-    │
   │ (Liquid block) │ 署名HMAC │   │  app-remix            │◀───── cron / Flow
   │ PDP に表示     │         │   │                       │  POST /jobs/expire-sweep
   └───────────────┘         │   │  ・App Proxy ルート    │  (共有シークレット)
       顧客（EC 来訪）        │   │  ・Admin 埋め込み画面  │
                              │   │  ・webhook ハンドラ    │
   ┌───────────────┐         │   │  ・期限切れ job        │
   │ POS UI 拡張    │ Bearer  │   │  ・lib/pickup/*.server │
   │ pickup-home    │  JWT    │   └───────────────────────┘
   │ (Preact)       │─────────┘            ▲
   │ tile + modal   │   +CORS              │ 埋め込み (App Bridge)
   └───────────────┘                ┌──────┴───────┐
    店舗スタッフ（POS）              │ 店長/管理者   │
                                     │ (Admin 画面)  │
                                     └──────────────┘
```

### 1-2. 各コンポーネントの責務

| コンポーネント | 実体 | 責務 |
|---|---|---|
| **EC テーマ拡張** | `extensions/pickup-form`（Theme App Extension / Liquid app block） | PDP に取置きフォームを描画。ロケーション別在庫を取得し、取置き申請を送信。ログイン顧客限定。 |
| **Remix バックエンド** | `app/`（`@shopify/shopify-app-remix`） | App Proxy ルート（予約作成・在庫表示・一覧・引取り）、Admin 埋め込み画面、`orders/create` webhook、期限切れ job、`lib/pickup/*.server.ts` に Shopify API ロジックを集約。 |
| **POS UI 拡張** | `extensions/pickup-home`（Preact, `pos.home.tile.render` + `pos.home.modal.render`） | ホームにタイルを置き、モーダルで引取り待ち一覧を表示。引取り＝在庫戻し＋カート復元＋一括決済の起点。 |
| **Shopify プラットフォーム** | Draft Orders / Inventory / Customers / Flow / Orders | 予約レコードの保管庫（Draft Order）、在庫台帳、顧客情報、通知（Flow）、決済（Order）。 |

### 1-3. アクセススコープ

`shopify.app.toml`（逐語）:

```toml
[access_scopes]
scopes = "read_products,read_inventory,write_inventory,read_locations,read_draft_orders,write_draft_orders,read_orders,write_orders,read_customers,write_customers"
```

| スコープ | 用途 |
|---|---|
| `read_products` | variant / inventoryItem の解決 |
| `read_inventory` / `write_inventory` | ロケーション別在庫の参照と `available ↔ reserved` 移動 |
| `read_locations` | 有効ロケーション・isActive の取得 |
| `read_draft_orders` / `write_draft_orders` | 予約レコード（Draft Order）の作成・更新・タグ遷移・削除 |
| `read_orders` / `write_orders` | `orders/create` webhook での突合、注文紐付け |
| `read_customers` / `write_customers` | 顧客表示名・連絡先の best-effort 取得 |

> **意図的に追加していないスコープ:** `write_quick_sale` は使わない。通知も `draftOrderInvoiceSend` を使わず Shopify Flow に委譲する（理由は §10）。

---

## 2. 通信経路（App Proxy）詳細

### 2-1. App Proxy とは

ストアフロント（`https://<shop>.myshopify.com`）配下の `/apps/pickup/*` への HTTP リクエストを、Shopify がアプリのバックエンド URL に**署名付きで**転送する仕組み。EC のブラウザから直接アプリのトンネル URL を叩かせず、同一オリジン（ストアフロント）経由でアクセスさせられる。

`shopify.app.toml`（逐語）:

```toml
application_url = "https://nobu-pickup-fqclg2.tunnel.shopifycloud.tech"

[app_proxy]
url = "https://nobu-pickup-fqclg2.tunnel.shopifycloud.tech"
subpath = "pickup"
prefix = "apps"
```

**重要なパス変換:** Shopify は `prefix`＋`subpath`（= `/apps/pickup`）を**剥がして**転送する。したがってストアフロントの `POST /apps/pickup/reservations` は、アプリ側では `POST /reservations`（= `app/routes/reservations.tsx`）に届く。同様に `/apps/pickup/locations` → `app/routes/locations.tsx`。

```
ブラウザ                         Shopify                      Remix バックエンド
   │  POST /apps/pickup/reservations │                              │
   ├────────────────────────────────▶│ HMAC署名を付与・検証          │
   │                                 │  /apps/pickup を剥がす        │
   │                                 ├─ POST /reservations ─────────▶│ reservations.tsx
   │                                 │  ?logged_in_customer_id=...   │ authenticate.public.appProxy
   │◀────────────── 201 JSON ────────┼──────────────────────────────┤
```

### 2-2. 3 つの呼び出し経路と認証方式

| 経路 | エンドポイント（ストアフロント / 直叩き） | 呼び出し元 | 認証 | Remix での検証 |
|---|---|---|---|---|
| **A. 予約作成・在庫表示** | `POST /apps/pickup/reservations`, `GET /apps/pickup/locations` | EC フォーム | **App Proxy 署名 (HMAC)** | `authenticate.public.appProxy(request)` |
| **B. 一覧・引取り** | `GET /apps/pickup/reservations/list`, `POST /apps/pickup/reservations/:id/release` | POS UI 拡張 | **POS セッション JWT (Bearer) + CORS** | `authenticate.admin(request)` |
| **C-1. 完了化** | `POST /webhooks/orders/create` | Shopify | **Webhook HMAC** | `authenticate.webhook(request)` |
| **C-2. 期限切れ回収** | `POST /jobs/expire-sweep` | cron / Flow | **共有シークレット** | 自前検証 + `unauthenticated.admin(shop)` |

> **なぜ一覧・引取り（B）は App Proxy 署名でなく POS JWT なのか？** POS UI 拡張は EC のストアフロントではなく POS アプリの webview から動く。App Proxy の署名はストアフロント経由のリクエストにしか付かないため、POS からはアプリのトンネル URL を**直接**叩く。その代わり `shopify.session.getSessionToken()` が返す JWT を `Authorization: Bearer` で送り、`authenticate.admin` が検証 + token-exchange する。別オリジン webview からのアクセスになるため **CORS 許可**が必要（Cookie 不使用・Bearer のみなので `Origin: *` で安全）。

CORS ヘッダ（list / release ルート共通・逐語）:

```ts
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",   // release は "POST, OPTIONS"
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};
// OPTIONS プリフライトは認証前に 204 を返す。
```

---

## 3. データ構造（最重要章）

### 3-1. サーバ DB に何を保存しているか

**予約テーブルは存在しない。** `prisma/schema.prisma` は OAuth セッション保管用の `Session` モデルのみ（逐語）:

```prisma
datasource db {
  provider = "sqlite"
  url      = "file:dev.sqlite"
}

model Session {
  id                  String    @id
  shop                String
  state               String
  isOnline            Boolean   @default(false)
  scope               String?
  expires             DateTime?
  accessToken         String
  userId              BigInt?
  firstName           String?
  lastName            String?
  email               String?
  accountOwner        Boolean   @default(false)
  locale              String?
  collaborator        Boolean?  @default(false)
  emailVerified       Boolean?  @default(false)
  refreshToken        String?
  refreshTokenExpires DateTime?
}
```

予約の状態・メタ・在庫はすべて Shopify 側（Draft Order / Inventory / Metafields）に持つ。**これがこのアプリの設計の核心**で、専用 DB の運用・同期・整合性管理を不要にしている。

### 3-2. Draft Order を予約レコードにする設計

#### タグ設計（`app/lib/pickup/constants.ts` 逐語）

```ts
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
```

1 件の取置き Draft には、作成時に次の 4 種のタグが付く（`createPickupDraft` 内・逐語）:

```ts
tags: [
  TAG_BASE,                    // "pickup-reservation"（一覧抽出の起点）
  statusTag("reserved"),       // "pickup-status:reserved"（状態）
  locationTag(legacyLoc),      // "pickup-location:<legacy数値ID>"（受取店舗）
  idemTag(p.idempotencyKey),   // "pickup-idem:<sha1先頭16hex>"（冪等索引）
],
```

#### 40 文字制限の落とし穴 → ハッシュ索引

Shopify のタグは**最大 40 文字**。冪等キー（UUID なら 36 文字）をそのままタグにすると `pickup-idem:` (12) + 36 = 48 文字で `draftOrderCreate` が `"Tag exceeds the maximum length of 40 characters"` の userError を返し、App Proxy 側は 422 になる。これを回避するため、タグには **sha1 先頭 16 hex（64bit）** の固定長ハッシュだけを入れ、**完全な冪等キーは customAttribute に保持**する（`constants.ts` 逐語）:

```ts
/**
 * idempotencyKey をタグに埋め込むための固定長ハッシュ。
 * Shopify のタグは最大 40 文字。... 衝突しにくい固定長（sha1 先頭 16hex = 64bit）
 * に変換して格納する。完全な idempotencyKey は customAttribute(ATTR.idem) に保持する
 * ため、このハッシュは「重複検出のための索引」としてのみ用いる。
 */
export const idemHash = (idempotencyKey: string): string =>
  createHash("sha1").update(idempotencyKey).digest("hex").slice(0, 16);

export const idemTag = (idempotencyKey: string) =>
  `${IDEM_TAG_PREFIX}${idemHash(idempotencyKey)}`;
```

#### customAttributes 一覧（`constants.ts` の `ATTR` 逐語）

```ts
export const ATTR = {
  reservationNo: "pickup_reservation_no",
  locationId: "pickup_location_id",
  locationName: "pickup_location_name",
  expiresAt: "pickup_expires_at",
  qty: "pickup_qty",
  variantId: "pickup_variant_id",
  customerId: "pickup_customer_id",
  customerName: "pickup_customer_name",
  customerPhone: "pickup_customer_phone",
  idem: "pickup_idem",
  orderId: "pickup_order_id",
} as const;
```

| キー | 意味 | 備考 |
|---|---|---|
| `pickup_reservation_no` | 受取番号 `R-XXXXXX` | 冪等キーから決定的に導出 |
| `pickup_location_id` | 受取店舗の GID | `parseReservation` の主情報源 |
| `pickup_location_name` | 受取店舗名（表示用） | |
| `pickup_expires_at` | 期限（ISO8601） | sweep の判定に使用 |
| `pickup_qty` | 数量 | |
| `pickup_variant_id` | variant の GID | |
| `pickup_customer_id` | 顧客 legacy 数値 ID | `purchasingEntity` を使わないため必須（§10） |
| `pickup_customer_name` | 顧客表示名 | best-effort 取得 |
| `pickup_customer_phone` | 顧客電話 | best-effort 取得 |
| `pickup_idem` | **完全な**冪等キー | 完了時に Order の note_attributes へ引き継がれ webhook が突合 |
| `pickup_order_id` | 完了後に紐づく販売 Order の GID | Draft は残し、この属性で注文を辿る |

#### note2（人間可読メモ）と受取番号の導出

`note2` は管理者が Draft Order 画面で見たときに分かるよう、次の書式で書く（`buildNote` 逐語）:

```ts
function buildNote(locationName, expiresAtIso, reservationNo): string {
  return `${locationName} 取置き / 期限 ${formatExpiryJST(expiresAtIso)} / 受取番号 ${reservationNo}`;
}
```

受取番号は連番カウンタを使わず、冪等キーから決定的に導出する（`reservationNoFromIdem` 逐語）:

```ts
export function reservationNoFromIdem(idempotencyKey: string): string {
  const h = createHash("sha1").update(idempotencyKey).digest("hex");
  return `R-${h.slice(0, 6).toUpperCase()}`;
}
```

**lineItems** は取置き対象の variant × 数量を 1 行で持つ（`createPickupDraft` の input より）:

```ts
lineItems: [{ variantId: p.variantId, quantity: p.quantity }],
```

### 3-3. 取置きフォームが送信するデータ

EC → `POST /apps/pickup/reservations` の JSON ボディ（`store_pickup_form.liquid` 逐語）:

```js
// 顧客情報は送らない。サーバ側が App Proxy 署名済み logged_in_customer_id から特定する。
var payload = {
  variantId: currentVariantId,        // 数値 or GID（サーバが正規化）
  locationId: sel.value,              // ロケーション GID
  quantity: parseInt(form.quantity.value, 10) || 1,
  idempotencyKey: idemKey             // crypto.randomUUID()
};
```

**送るのはこの 4 つだけ。** 氏名・メール・電話は**送らない**。顧客はサーバ側が署名済み `logged_in_customer_id`（App Proxy が URL クエリに付与）から特定する。サーバはスネーク/キャメル両表記を受け、ID を正規化する（`reservations.tsx` 逐語）:

```ts
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
// pick(body, "variantId", "variant_id") のようにキャメル/スネーク両対応
```

### 3-4. Reservation インターフェース（アプリ内部のドメイン型）

`app/lib/pickup/draft.server.ts` 逐語。Draft Order ノードを `parseReservation` で正規化した、アプリ全体の単一ドメイン型:

```ts
export interface ReservationLineItem {
  id: string;
  title?: string;
  quantity: number;
  variantId: string | null;
  inventoryItemId: string | null;
}

export interface Reservation {
  id: string;                 // DraftOrder GID
  legacyResourceId: string;
  name: string;
  status: PickupStatus | null;
  tags: string[];
  locationId: string | null;  // GID
  legacyLocationId: string | null;
  locationName: string | null;
  expiresAt: string | null;   // ISO8601
  isExpired: boolean;
  reservationNo: string | null;
  qty: number | null;
  variantId: string | null;
  customerId: string | null;  // 顧客 legacyResourceId（数値文字列）
  email: string | null;
  customerName: string | null;
  customerPhone: string | null;
  idempotencyKey: string | null;
  note: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  orderId: string | null;
  totalPrice: { amount: string; currencyCode: string } | null;
  lineItems: ReservationLineItem[];
}
```

`parseReservation` は **タグと customAttributes の両方**から値を解決する。特に冪等キーは customAttribute を優先し、旧データ（タグに全長を入れていた頃）にもフォールバックする（逐語抜粋）:

```ts
// 完全な idempotencyKey は customAttribute に保持する（タグはハッシュ索引）。
// 旧データ（タグに全長を格納）でも tagValue フォールバックで読める。
idempotencyKey: attrs.get(ATTR.idem) ?? tagValue(tags, IDEM_TAG_PREFIX),
// ...
// POS は取置き Draft とは別に Order を作る（draftOrderComplete 不使用）ため
// node.order は基本 null。完了時に webhook が customAttribute へ書く GID を読む。
orderId: node.order?.id ?? attrs.get(ATTR.orderId) ?? null,
```

### 3-5. POS へ渡す DTO

一覧ルートは `Reservation` をそのまま返さず、POS Cart API に都合の良い軽量 DTO に整形する（`apps.pickup.reservations.list.tsx` の `toDto` 逐語）:

```ts
function toDto(r: Reservation) {
  return {
    draftId: r.legacyResourceId,       // /release のパスに使う legacy 数値 id
    name: r.name,
    reservationNo: r.reservationNo,
    status: r.status,
    locationName: r.locationName,
    locationId: r.locationId,
    legacyLocationId: r.legacyLocationId,  // POS 現在ロケーションと突合
    expiresAt: r.expiresAt,
    isExpired: r.isExpired,
    qty: r.qty,
    idempotencyKey: r.idempotencyKey,  // カート属性に載せ webhook が突合
    customerId: r.customerId,          // 顧客グルーピング & カート顧客自動セット
    customerName: r.customerName,
    email: r.email,
    customerPhone: r.customerPhone,
    note: r.note,
    lineItems: r.lineItems
      .filter((li) => li.variantId)
      .map((li) => ({
        variantId: legacyIdFromGid(li.variantId as string),  // POS Cart API 用に数値文字列へ
        quantity: li.quantity,
        title: li.title ?? null,
      })),
  };
}
```

> ポイント: POS の `shopify.cart.addLineItem` は**数値**の variant id を要求するため、GID を `legacyIdFromGid` で数値文字列に変換して渡す。

---

## 4. 処理の流れ

### 4-1. 予約状態マシン

```
                    EC 申請（在庫 available→reserved）
                              │
                              ▼
                    ┌──────────────────┐
          取消 ◀────┤     reserved      ├────▶ 期限切れ sweep
   (reserved→avail) │   （取置き中）     │   (reserved→available)
          │         └────────┬─────────┘         │
          ▼                  │ POS で引取り        ▼
   ┌────────────┐            │ (reserved→avail)  ┌──────────┐
   │ cancelled  │            ▼                   │ expired  │
   │（キャンセル）│   ┌──────────────┐            │（期限切れ）│
   └────────────┘   │   released    │            └──────────┘
                    │（引取り対応中）│
                    └───────┬───────┘
                            │ orders/create webhook
                            │ （店頭決済で Order 作成）
                            ▼
                    ┌──────────────┐
                    │  completed   │ ← 販売 Order GID を pickup_order_id に紐付け
                    │   （完了）    │   Draft は削除せず履歴として残す
                    └──────────────┘
```

各遷移は **「タグの付け替え」＋「在庫移動」** の組で実装される。タグ遷移は `setStatus`（旧ステータスタグを全除去 → 新規付与）で行う（`draft.server.ts` 逐語）:

```ts
export async function setStatus(admin, draftId, status): Promise<void> {
  await adminGraphql(admin, M_TAGS_REMOVE, { id: draftId, tags: ALL_STATUS_TAGS });
  await adminGraphql(admin, M_TAGS_ADD,    { id: draftId, tags: [statusTag(status)] });
}
```

### 4-2. 在庫状態の移動モデル

`on_hand`（物理在庫）は**動かさず**、`available`（販売可能）と `reserved`（取置き確保）の間だけを移す。これにより `on_hand = available + reserved`（＋committed）の不変条件が常に保たれる。

```
  申請前:   on_hand=10   available=10   reserved=0
              │ reserve（×3）
              ▼
  取置き中:  on_hand=10   available=7    reserved=3   ← available が減り reserved が増える
              │ release / expire（×3）
              ▼
  戻し後:    on_hand=10   available=10   reserved=0   ← on_hand は一貫して 10
```

| アクション | from → to | CAS（changeFromQuantity） | reason | idemKey |
|---|---|---|---|---|
| **Reserve** | available → reserved | **あり**（1 回リトライ） | `reservation_created` | `<draftId>:reserve` |
| **Release** | reserved → available | **なし**（寛容に clamp） | `reservation_deleted` | `<draftId>:release` |
| **Expire** | reserved → available | **なし**（寛容に clamp） | `reservation_deleted` | `<draftId>:expire` |

在庫移動の GraphQL は 2026-04 で `@idempotent(key:)` が必須（`inventory.server.ts` 逐語）:

```ts
const M_MOVE = `#graphql
  mutation Move($input: InventoryMoveQuantitiesInput!, $idem: String!) {
    inventoryMoveQuantities(input: $input) @idempotent(key: $idem) {
      inventoryAdjustmentGroup { id createdAt reason referenceDocumentUri }
      userErrors { field message code }
    }
  }`;
```

> **Shopify 仕様の落とし穴:** `available` 以外（`reserved` 等）を動かす側は `ledgerDocumentUri` が必須（`available` 側は `null` 可）。両側 `null` だと 422 になる。実装では `ledgerFor(name)` が `available → null` / それ以外 → `referenceDocumentUri` を返す。

Reserve は楽観ロック（CAS）で在庫変動を検知し、衝突したら最新値を取り直して 1 回だけ再試行する（`reserveAtLocation` 逐語抜粋）:

```ts
for (let attempt = 0; attempt < 2; attempt++) {
  const result = await move(admin, { /* available→reserved, changeFromQuantity=expected */ });
  if (result.ok) return { adjustmentGroupId: result.adjustmentGroupId };
  const conflict = looksLikeConflict(result.userErrors);
  const canRetry = attempt === 0 && conflict && !!params.refetch;
  if (canRetry) { expected = await params.refetch!(); continue; }
  if (conflict) throw new InventoryConflictError();
  throw new UserError("inventoryMoveQuantities (reserve) failed", result.userErrors);
}
```

Release/Expire は二重実行・期限切れ競合に強いよう CAS を使わず、現在 reserved に収まる量だけ戻す（`releaseInventory` 逐語抜粋）:

```ts
const moveQty = Math.min(params.quantity, Math.max(0, params.currentReserved));
if (moveQty <= 0) {
  // すでに戻し済み（reserved が無い）。冪等な成功とみなす。
  return { adjustmentGroupId: null, movedQuantity: 0 };
}
// ... move 実行 ...
if (!result.ok) {
  if (looksLikeConflict(result.userErrors)) {
    return { adjustmentGroupId: null, movedQuantity: 0 };  // 競合は成功扱い
  }
  throw new UserError("inventoryMoveQuantities (release) failed", result.userErrors);
}
```

### 4-3. フォーム表示時（ロケーション別在庫確認）

PDP のフォームは表示時に `GET /apps/pickup/locations?variantId=...` を叩く。サーバは `enabledLocationsForVariant` で **「Admin で有効化された店舗（未設定なら全店）∩ isActive ∩ available > 0」** のロケーションだけを返す（`locations.server.ts` 逐語抜粋）:

```ts
const locations: LocationOption[] = variant.levels
  .filter((lvl) => lvl.isActive && lvl.available > 0)
  .filter((lvl) => (enabledSet ? enabledSet.has(lvl.locationId) : true))
  .map((lvl) => ({
    locationId: lvl.locationId,
    legacyLocationId: lvl.legacyLocationId,
    name: lvl.name,
    available: lvl.available,
  }));
```

在庫は variant の `inventoryItem.inventoryLevels` から `quantities(names: ["available","reserved","on_hand","committed"])` で取得する（`Q_VARIANT_INVENTORY` 逐語）:

```graphql
query VariantInventory($id: ID!, $names: [String!]!) {
  productVariant(id: $id) {
    id title displayName
    inventoryItem {
      id tracked
      inventoryLevels(first: 50) {
        edges { node {
          location { id name isActive }
          quantities(names: $names) { name quantity }
        } }
      }
    }
  }
}
```

ショップ設定（対象ロケーション・保持時間）は shop metafield から読む（`Q_SHOP_CONFIG` 逐語）:

```graphql
query ShopPickupConfig {
  shop {
    id name
    enabledLocations: metafield(namespace: "pickup", key: "enabled_locations") { id type value }
    holdHours: metafield(namespace: "pickup", key: "hold_hours") { id type value }
  }
}
```

### 4-4. フォーム送信時（予約作成）— STEP 1〜8

`app/routes/reservations.tsx` の `action`。処理順を厳守する（逐語の STEP コメント付き）:

```ts
// 認証: authenticate.public.appProxy が HMAC 署名を自動検証
const { admin, session } = await authenticate.public.appProxy(request);

// ログイン顧客限定（署名済み logged_in_customer_id のみ信用）
const loggedInCustomerId = new URL(request.url).searchParams.get("logged_in_customer_id");
if (!loggedInCustomerId || !/^\d+$/.test(loggedInCustomerId)) {
  return jsonResponse({ error: "login_required", message: "取置きにはログインが必要です。" }, { status: 401 });
}
const customerGid = `gid://shopify/Customer/${loggedInCustomerId}`;

// ---- STEP 1: 冪等性 ----
const existing = await findByIdem(admin, input.idempotencyKey);
if (existing) {
  return jsonResponse({ ok: true, idempotent: true, reservation: summarize(existing) }, { status: 200 });
}

// ---- STEP 2: 在庫・ロケーション確認 ----
const [config, inv] = await Promise.all([
  getShopConfig(admin),
  getVariantInventory(admin, input.variantId),
]);
// variant_not_found(404) / not_tracked(422) / location_not_enabled(422) /
// location_unavailable(422) のガード...
if (level.available < input.quantity) {
  return jsonResponse({ error: "in_stock_changed", available: level.available }, { status: 409 });
}

// ---- STEP 3: Draft Order 作成（= 予約レコード）----
const expiresAtIso = new Date(Date.now() + config.holdHours * 60 * 60 * 1000).toISOString();
const reservation = await createPickupDraft(admin, { /* variantId, quantity, locationId, locationName, expiresAtIso, idempotencyKey, customerId */ });

// ---- STEP 4-5: available -> reserved（CAS + @idempotent）----
try {
  await reserveAtLocation(admin, {
    inventoryItemId, locationId, quantity,
    draftLegacyId: reservation.legacyResourceId,
    expected: { available: level.available, reserved: level.reserved },
    refetch: async () => { /* 最新の available/reserved を取り直す。不足なら InsufficientInventoryError */ },
  });
} catch (moveErr) {
  // ---- STEP 6: ロールバック ----
  await deleteDraft(admin, reservation.id).catch(/* ログのみ */);
  if (moveErr instanceof InsufficientInventoryError) return jsonResponse({ error: "in_stock_changed", available: moveErr.available }, { status: 409 });
  if (moveErr instanceof InventoryConflictError)    return jsonResponse({ error: "inventory_conflict" }, { status: 409 });
  throw moveErr;
}

// ---- STEP 7: 通知は Flow（reserved タグ起点）に委譲 ----
// ---- STEP 8: 成功 ----
return jsonResponse({ ok: true, idempotent: false, reservation: summarize(reservation) }, { status: 201 });
```

**エラーコード対応表:**

| HTTP | error | 意味 |
|---|---|---|
| 401 | `login_required` | 未ログイン（`logged_in_customer_id` 無し） |
| 400 | `missing_fields` / `invalid_ids` / `invalid_quantity` | 入力不正 |
| 404 | `variant_not_found` | variant が存在しない |
| 422 | `not_tracked` / `location_not_enabled` / `location_unavailable` | 取置き不可な状態 |
| 409 | `in_stock_changed` | 在庫不足（available < 要求数） |
| 409 | `inventory_conflict` | CAS 衝突（同時更新） |
| 200 | `{ ok, idempotent: true }` | 冪等ヒット（既存予約を返す） |
| 201 | `{ ok, idempotent: false }` | 新規作成成功 |
| 422 | `operation_failed`（details 付き） | draftOrderCreate userError（非 PII の文言を本文に含め自己診断可能に） |

### 4-5. POS カート追加時（引取り）

POS モーダルの `handlePickup` がコアフロー（`Modal.jsx` 逐語抜粋）:

```ts
// (a) 在庫を reserved -> available に戻す（既存 /release ルート）。
const res = await fetch(releaseUrl(r.draftId), {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
});
// 409=引取り不可 / 404=未検出 / 401,403=認証失敗 をハンドリング

// (b) POS カートへ明細を復元（addLineItem は数値 variant id）。
for (const li of r.lineItems ?? []) {
  const variantNum = Number(li.variantId);
  if (!Number.isFinite(variantNum) || variantNum <= 0) continue;
  await shopify.cart.addLineItem(variantNum, li.quantity);
}

// (c) 予約キーを「カンマ連結で累積」（既存値に追記）。
const props = {};
if (r.idempotencyKey)  props.pickup_idem = mergeCsv(existing.pickup_idem, r.idempotencyKey);
if (r.reservationNo)   props.pickup_reservation_no = mergeCsv(existing.pickup_reservation_no, r.reservationNo);
if (Object.keys(props).length > 0) await shopify.cart.addCartProperties(props);

// (d) 初回のみカート顧客を自動セット（数値 customer id 必須・非致命）。
if (!customerSet && r.customerId && typeof shopify.cart.setCustomer === "function") {
  const cur = shopify.cart.current?.value;
  if (!cur?.customer) {
    const cid = Number(r.customerId);
    if (Number.isFinite(cid) && cid > 0) {
      try { await shopify.cart.setCustomer({ id: cid }); setCustomerSet(true); }
      catch { setError("カートへの顧客自動セットに失敗しました。..."); }
    }
  }
}

// (e) 引取り済みを一覧から除去 & 累計に加算。一覧に留まる（続けて引取り可能）。
setReservations((cur) => cur.filter((x) => x.draftId !== r.draftId));
setPicked((cur) => [...cur, { reservationNo: r.reservationNo, name: r.name, qty: r.qty }]);
```

`/release` ルート側は冪等に振る舞う（`apps.pickup.reservations.$draftId.release.tsx` 逐語抜粋）:

```ts
// 既に引取り済み/完了済みなら冪等に成功扱い。
if (r.status === "released" || r.status === "completed") {
  return jsonResponse({ ok: true, alreadyReleased: true, status: r.status, ... });
}
// reserved 以外（expired/cancelled）は引取り対象外。
if (r.status !== "reserved") {
  return jsonResponse({ ok: false, error: "not_releasable", status: r.status }, { status: 409 });
}
const { releasedQuantity } = await releaseReservation(admin, r, "release");
await setStatus(admin, gid, "released");
```

### 4-6. 決済後（完了化＋注文紐付け）

POS は取置き Draft を `draftOrderComplete` するのではなく、カートを**新規 Order として決済**する。Order の `note_attributes` には元 Draft の customAttributes（`pickup_idem` 含む）が引き継がれるため、`orders/create` webhook がそれを読んで元予約を再特定する（`webhooks.orders.create.tsx` 逐語抜粋）:

```ts
const rawIdem = (order.note_attributes ?? []).find((a) => a.name === ATTR.idem)?.value;
if (!rawIdem) return new Response();  // 取置き由来でない通常注文は無視

const orderGid = order.admin_graphql_api_id ?? null;

// 複数予約の一括決済はカンマ連結。分割 → trim → 空除去 → 重複除去。
const idemKeys = [...new Set(rawIdem.split(",").map((k) => k.trim()).filter((k) => k.length > 0))];

for (const idemKey of idemKeys) {
  try { await completeOne(admin, idemKey, orderGid, shop, topic); }
  catch (e) { /* webhook は常に 200。処理は冪等なので次回 sweep 等で回収可 */ }
}
```

`completeOne`（逐語抜粋）— release 漏れ検知 → completed 化 → 注文紐付け:

```ts
const reservation = await findByIdem(admin, idemKey);
if (!reservation) return;  // 完了済み/対象外（冪等）

// release 漏れ（reserved のまま決済成功）→ 在庫を戻してから completed に。
if (reservation.status === "reserved") {
  console.error(`[${topic}] ${shop}: ALERT release漏れ検知 ...`);
  await releaseReservation(admin, reservation, "release");
}

// 既に completed なら setStatus は冪等。
if (reservation.status !== "completed") {
  await setStatus(admin, reservation.id, "completed");
}

// 取置き記録（Draft）は削除せず残し、対応する販売 Order を紐づける（再配信に冪等）。
if (orderGid && reservation.orderId !== orderGid) {
  await linkOrder(admin, reservation, orderGid);
}
```

> **⚠️ Draft を削除してはいけない（v11 撤回の教訓）。** 一度「完了時に Draft を削除」する実装にしたところ、Admin 取置き一覧の「完了」タブが空になった。**Draft 自体が予約レコード**なので、削除 = 完了履歴の消失。完了後も Draft は残し、`pickup_order_id` で販売 Order を辿れるようにする。

`linkOrder` は `draftOrderUpdate` の customAttributes が**全置換**である点に注意（既存属性を復元してから order だけ足す。`draft.server.ts` 逐語抜粋）:

```ts
export async function linkOrder(admin, reservation, orderGid): Promise<void> {
  const attrs = attrMapFromReservation(reservation);  // 既存属性を復元
  attrs.set(ATTR.orderId, orderGid);
  const customAttributes = Array.from(attrs.entries()).map(([key, value]) => ({ key, value }));
  await adminGraphql(admin, M_UPDATE, { id: reservation.id, input: { customAttributes } });
}
```

### 4-7. 期限切れ sweep

`runExpireSweep` がページングで reserved を走査し、期限超過を回収する。retag すると `reserved` フィルタから外れるので毎パス先頭ページを取り直し、期限切れが無くなれば収束（`sweep.server.ts` 逐語抜粋）:

```ts
const MAX_PASSES = 20;
const PAGE_SIZE = 50;

while (passes < MAX_PASSES) {
  const { reservations } = await listReservations(admin, { status: "reserved", first: PAGE_SIZE });
  const now = Date.now();
  const expired = reservations.filter((r) => r.expiresAt != null && Date.parse(r.expiresAt) < now);
  if (expired.length === 0) break;
  for (const r of expired) {
    try {
      const { releasedQuantity: q } = await releaseReservation(admin, r, "expire");
      await setStatus(admin, r.id, "expired");
      swept += 1; releasedQuantity += q;
    } catch (perItem) {
      failed.push(r.reservationNo ?? r.legacyResourceId);  // 1 件失敗しても次へ。PII を出さない
    }
  }
  passes += 1;
}
```

エンドポイント `POST /jobs/expire-sweep` はセッションを持たないため、共有シークレットで保護し `unauthenticated.admin(shop)` でオフライントークンを使う（`jobs.expire-sweep.tsx` 逐語抜粋）:

```ts
// ---- 共有シークレット検証 ----
const expected = process.env.PICKUP_EXPIRE_SWEEP_SECRET?.trim();
const provided = extractSecret(request);  // Bearer or X-Pickup-Sweep-Secret
if (!provided || !safeEqual(provided, expected)) {
  return jsonResponse({ error: "unauthorized" }, { status: 401 });
}
// ---- 対象ストア解決（query/body/form/PICKUP_SHOP env）----
const shop = await resolveShop(request);   // /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/ で検証
const { admin } = await unauthenticated.admin(shop);
const { swept, releasedQuantity, passes, failed } = await runExpireSweep(admin);
```

> 通常は Shopify Flow の「Scheduled time → Send HTTP request」で毎時起動する想定。Admin 設定画面の「期限切れを今すぐ処理」ボタンからも同じ `runExpireSweep` を呼べる。

---

## 5. EC 側取置きフォーム 詳細解説

実体は `extensions/pickup-form/blocks/store_pickup_form.liquid`（Theme App Extension の app block）。`shopify.extension.toml` は `type = "theme"`。

### 5-1. ログイン顧客限定の分岐

```liquid
{%- if customer -%}
  <!-- フォーム本体（locationId select + quantity input + submit） -->
{%- else -%}
  <!-- ログイン誘導: routes.account_login_url?return_url=... -->
  <a href="{{ routes.account_login_url }}?return_url={{ request.path | url_encode }}">
    {{ pb.login_link_label | escape }}
  </a>
{%- endif -%}
```

宛名は氏名が空なら email を使う（氏名なしでも顧客アカウントは作成できるため）:

```liquid
{%- assign greet_name = customer.name | strip -%}
{%- if greet_name == blank -%}{%- assign greet_name = customer.email -%}{%- endif -%}
```

### 5-2. variant 解決のフォールバック

取置きは「オンライン販売可否に関係なく特定ロケーションの在庫を押さえる」用途なので、販売可能 variant が無くても variant.id を必ず出力する:

```liquid
{%- assign init_variant = product_obj.selected_or_first_available_variant -%}
{%- if init_variant == blank -%}
  {%- assign init_variant = product_obj.variants.first -%}
{%- endif -%}
```

### 5-3. JS の要点

- **冪等キー生成**: `crypto.randomUUID()`（フォールバックで疑似 UUID）。送信成功ごとに `idemKey = newIdem()` で更新し、二重送信を防ぎつつ「再申し込み」は別予約にする。
- **variant 切替の追従**: 商品フォームの `[name="id"]` の change と、テーマ依存の `variant:change` カスタムイベントの両方を監視し、変わったら `loadLocations()` し直す。
- **入力は location（select）＋ quantity のみ**。顧客情報の手入力欄は無い。
- **レスポンスハンドリング**: 201/200 で成功表示（受取店舗・期限・受取番号）、409 で「在庫が変動しました」→ 在庫表示を更新。

```js
fetch(reservationsUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Accept": "application/json" },
  body: JSON.stringify(payload)
})
  .then(/* r.json() */)
  .then(function (res) {
    if (res.status === 201 || res.status === 200) {
      // reservation.locationName / expiresAt / reservationNo を表示
      idemKey = newIdem(); loadLocations();
    } else if (res.status === 409) {
      showStatus("error", T.stockChanged); loadLocations();
    } else {
      showStatus("error", T.genericError);
    }
  });
```

### 5-4. App Proxy ベースパスの設定

URL は theme editor の設定（`proxy_base`, 既定 `/apps/pickup`）から組み立て、`{{ pb.proxy_base }}/locations` / `{{ pb.proxy_base }}/reservations` を `data-*` 属性に出す。`shopify.app.toml` の `app_proxy`（prefix/subpath）と一致させること。

`locations` レスポンス形（`locations.tsx` 逐語）:

```ts
return jsonResponse({
  variantId: variant.variantId,
  title: variant.displayName,
  tracked: variant.tracked,
  holdHours,
  locations: locations.map((l) => ({
    locationId: l.locationId,
    legacyLocationId: l.legacyLocationId,
    name: l.name,
    available: l.available,
  })),
});
```

---

## 6. POS 側アプリ 詳細解説

実体は `extensions/pickup-home`（Preact）。`shopify.extension.toml`（逐語）:

```toml
api_version = "2026-04"

[[extensions]]
type = "ui_extension"
name = "t:name"
handle = "pickup-home"
description = "A preact POS UI extension"

[[extensions.targeting]]
module = "./src/Tile.jsx"
target = "pos.home.tile.render"

[[extensions.targeting]]
module = "./src/Modal.jsx"
target = "pos.home.modal.render"
```

### 6-1. タイル → モーダル

`Tile.jsx`（逐語）はホーム（スマートグリッド）に常設のエントリポイントを置き、タップで `pos.home.modal.render` を開く:

```jsx
function Tile() {
  return (
    <s-tile
      heading="取置き引取り"
      subheading="引取り待ちの取置きを確認・引渡し"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
```

> **POS タイルの配置手順:** Admin の POS エディタ（販売チャネル → Point of Sale → 設定 → カスタマイズ「POSアプリ」 → スマートグリッド → ⊕タイル追加 → アプリ → 保存）から配置する。POS デバイス側の「タイル追加 → アプリ」では配置できない。

### 6-2. config.js の APP_URL ハードコード問題

POS UI 拡張には**アプリ URL を返す組み込み API が無い**ため、トンネル URL を `config.js` に直書きする（逐語）:

```js
export const APP_URL = "https://nobu-pickup-fqclg2.tunnel.shopifycloud.tech";

export function listUrl(status = "reserved") {
  return `${APP_URL}/apps/pickup/reservations/list?status=${encodeURIComponent(status)}`;
}
export function releaseUrl(draftLegacyId) {
  return `${APP_URL}/apps/pickup/reservations/${draftLegacyId}/release`;
}
```

> **URL カップリングに注意:** `application_url` / `app_proxy.url` / この `APP_URL` の 3 箇所を一致させること。トンネル URL が変わると POS 拡張が壊れる。`shopify app dev` を再起動するとトンネル URL が変わるため、本番運用では**永続トンネル**を使う（§9）。

### 6-3. 利用中ロケーションだけ表示

POS デバイスの現在ロケーション `shopify.session.currentSession.locationId`（**数値**）と、予約 DTO の `legacyLocationId` を `String()` 同士で突合し、その店舗の取置きだけを表示する。取得不可なら安全側で全件表示（`Modal.jsx` 逐語）:

```ts
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
```

非表示分は「他ロケーションの取置き N 件はこの店舗では非表示です。」と通知する。

### 6-4. 複数取置きの一括投入（mergeCsv）

複数の取置きを 1 カートに載せても全件が突合されるよう、カート属性をカンマ連結で累積する（`mergeCsv` 逐語）:

```ts
/** カンマ連結文字列に値を追加（trim + 空除去 + 重複除去）。 */
function mergeCsv(existing, value) {
  const set = new Set(
    String(existing ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  if (value) set.add(String(value).trim());
  return [...set].join(",");
}
```

これにより `pickup_idem` は `"keyA,keyB,…"` となり、`orders/create` webhook 側が分割して各件を completed 化する（§4-6 と対応）。

### 6-5. 顧客グループ化・累計バナー・商品名表示

```ts
/** 予約を顧客（customerId 優先・無ければ customerName）でグループ化する。 */
function groupByCustomer(list) {
  const groups = new Map();
  for (const r of list) {
    const key = r.customerId || r.customerName || "__none__";
    if (!groups.has(key)) {
      groups.set(key, { key, name: r.customerName || "（顧客未設定）", items: [] });
    }
    groups.get(key).items.push(r);
  }
  return [...groups.values()];
}

/** 取置き商品名（複数明細は「商品名 × 数量、…」で連結）。 */
function lineItemsLabel(r) {
  const items = (r.lineItems ?? []).filter((li) => li.title);
  if (items.length === 0) return "";
  return items.map((li) => `${li.title} × ${li.quantity}`).join("、");
}
```

引取り済みは `picked` に積んで累計バナー（「N件をカートに追加済み…カートタブで一括決済してください。」）を出し、一覧に留まって続けて引取りできる。

> **モーダルを閉じるのは `window.close()`。** 現行 POS UI（統一 Preact）には `shopify.action.dismiss()` は無い。カート遷移 API も無いため、スタッフは閉じた後に手動でカート（レジ）タブへ移って一括決済する。

```jsx
<s-button variant={picked.length > 0 ? "primary" : "secondary"} onClick={() => window.close()}>
  {picked.length > 0 ? "閉じる（カートで決済）" : "閉じる"}
</s-button>
```

### 6-6. 認証

一覧・引取りとも `shopify.session.getSessionToken()` の JWT を `Authorization: Bearer` で送る:

```ts
const token = await shopify.session.getSessionToken();
const res = await fetch(listUrl("reserved"), { headers: { Authorization: `Bearer ${token}` } });
```

---

## 7. Admin（埋め込みアプリ）解説

### 7-1. シェル（`app.tsx`）

`AppProvider isEmbeddedApp` + `NavMenu`（「取置き予約」「設定」）。すべてのルートで `authenticate.admin(request)`。

```jsx
<AppProvider isEmbeddedApp apiKey={apiKey}>
  <NavMenu>
    <Link to="/app" rel="home">取置き予約</Link>
    <Link to="/app/settings">設定</Link>
  </NavMenu>
  <Outlet />
</AppProvider>
```

### 7-2. 一覧（`app._index.tsx`）

フィルタタブ（すべて / 取置き中 / 引取り対応中 / 完了 / 期限切れ / キャンセル）、`IndexTable` の 7 列（受取番号 / 状態 / 店舗 / 数量 / 期限JST / お客様 / 申込JST）、`listReservations`（PAGE_SIZE=25）でカーソルページング。`reserved` かつ期限超過の行は期限を critical 表示し「（期限超過）」を付す。

```ts
const FILTERS = [
  { label: "すべて", value: "all" },
  { label: "取置き中", value: "reserved" },
  { label: "引取り対応中", value: "released" },
  { label: "完了", value: "completed" },
  { label: "期限切れ", value: "expired" },
  { label: "キャンセル", value: "cancelled" },
];
```

ステータスのラベル・トーンは `ui.ts` 集約（`reserved=取置き中/attention`, `released=引取り対応中/info`, `completed=完了/success`, `expired=期限切れ/warning`, `cancelled=キャンセル/—`）。日時はすべて `formatJst`（Asia/Tokyo）で表示。

### 7-3. 詳細・操作（`app.reservations.$id.tsx`）

予約内容・お客様・メタ・操作の 4 カード。操作（`reserved` のときのみ可）:

- **期限延長** (`extend`): `updateExpiry` で customAttributes と note を書き換え。
- **引取り** (`release`): `releaseReservation("release")` → `setStatus("released")`。来店受取・店頭決済の直前に押す。
- **再通知** (`renotify`): `setStatus("reserved")` でタグを付け直し、Flow の「タグ追加」トリガを再発火。
- **キャンセル** (`cancel`): `releaseReservation("release")` → `setStatus("cancelled")`。

完了予約には販売 Order へのリンクを出す（`pickup_order_id` → Admin 注文ページ。逐語抜粋）:

```ts
const orderLegacy = legacyFromGid(reservation.orderId);
const orderUrl = orderLegacy
  ? `https://admin.shopify.com/store/${storeHandle}/orders/${orderLegacy}`
  : null;
// storeHandle = session.shop.replace(/\.myshopify\.com$/, "")
```

### 7-4. 設定（`app.settings.tsx`）

- **取置き対象店舗**: チェックした店舗の GID 配列を `setEnabledLocations` で shop metafield (`pickup/enabled_locations`, type `json`) に保存。全 OFF（空配列）にすると取置き無効。未設定（null）は「全店対象」。
- **デフォルト取置き時間**: `setHoldHours` で `pickup/hold_hours`（type `number_integer`, 1〜720h）に保存。
- **期限切れを今すぐ処理**: `runExpireSweep` を手動実行。

---

## 8. Shopify に記録している情報まとめ（早見表）

### 8-1. Draft Order（= 予約レコード）

| 種別 | キー / 値 | 内容 |
|---|---|---|
| **tag** | `pickup-reservation` | ベース（一覧抽出の起点） |
| **tag** | `pickup-status:<status>` | reserved / released / completed / expired / cancelled |
| **tag** | `pickup-location:<legacyId>` | 受取店舗（数値 ID） |
| **tag** | `pickup-idem:<sha1先頭16hex>` | 冪等索引（40字制限回避のハッシュ） |
| **customAttribute** | `pickup_reservation_no` | 受取番号 `R-XXXXXX` |
| **customAttribute** | `pickup_location_id` / `pickup_location_name` | 受取店舗 GID / 名前 |
| **customAttribute** | `pickup_expires_at` | 期限 ISO8601 |
| **customAttribute** | `pickup_qty` / `pickup_variant_id` | 数量 / variant GID |
| **customAttribute** | `pickup_customer_id` / `_name` / `_phone` | 顧客 数値ID / 表示名 / 電話 |
| **customAttribute** | `pickup_idem` | 完全な冪等キー（webhook 突合用） |
| **customAttribute** | `pickup_order_id` | 完了後に紐づく販売 Order GID |
| **note2** | `<店舗> 取置き / 期限 <JST> / 受取番号 <No>` | 人間可読メモ |
| **lineItems** | `[{ variantId, quantity }]` | 取置き対象 |
| **email** | 顧客メール（解決できた場合） | |

### 8-2. shop metafield

| namespace | key | type | 内容 |
|---|---|---|---|
| `pickup` | `enabled_locations` | `json` | 対象ロケーション GID 配列（未設定=全店） |
| `pickup` | `hold_hours` | `number_integer` | デフォルト保持時間（既定 72） |

### 8-3. 在庫（Inventory）

- quantity states: `available` / `reserved` / `on_hand` / `committed`（取得対象）。動かすのは `available ↔ reserved` のみ。
- reason: Reserve=`reservation_created`, Release/Expire=`reservation_deleted`。
- 監査用 `referenceDocumentUri`: `gid://store-pickup-app/Reservation/<draftLegacyId>/<reserve|release|expire>`。
- `@idempotent(key:)`: `<draftLegacyId>:<reserve|release|expire>`。

---

## 9. ステージング（非開発）ストアでの開発の注意点

POS 実機検証には**常駐するバックエンド**が必要。`shopify app dev` は対話的でセッションが切れると止まるため、本番に近い検証では使わない。

### 9-1. バックエンドを `shopify app dev` に頼らず起動する

`@remix-run/serve` を常駐（:3000）させ、別途 cloudflared で**永続トンネル**を張る。

```bash
# 1. ビルド
pnpm exec remix vite:build

# 2. 常駐起動（@remix-run/serve を nohup で）
nohup env PORT=3000 node --env-file=.env \
  "$(node -e "console.log(require.resolve('@remix-run/serve/dist/cli.js'))")" \
  ./build/server/index.js > /tmp/backend.log 2>&1 & disown

# 3. ヘルスチェック（200 が返れば OK）
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/
```

トンネルは `application_url` / `app_proxy.url` / POS `config.js` の `APP_URL` と一致させた**固定 URL**を使う（例: `https://nobu-pickup-fqclg2.tunnel.shopifycloud.tech`）。

### 9-2. バックエンドの更新手順

`app/**`（サーバ側）を変更したら:

```bash
pnpm exec remix vite:build                 # 再ビルド
lsof -ti tcp:3000 | xargs kill             # 旧プロセスを停止
# → 9-1 の手順 2 で再起動
```

### 9-3. deploy の境界（重要）

```
┌─────────────────────────────┬──────────────────────────────────────────┐
│ shopify app deploy           │ 拡張（pickup-form / pickup-home）＋ toml   │
│                              │ のみを Shopify に push。                     │
├─────────────────────────────┼──────────────────────────────────────────┤
│ Remix バックエンド (app/**)  │ deploy には含まれない。                      │
│                              │ build + :3000 再起動で反映。                 │
└─────────────────────────────┴──────────────────────────────────────────┘
```

- **拡張（`extensions/**`）や toml を変えた** → `shopify app deploy`。
- **サーバ（`app/**`）を変えた** → `remix vite:build` + :3000 再起動（deploy 不要）。
- DTO（list ルートの `toDto` 等）を変えると POS が読む形が変わるので**サーバ再起動が必要**。拡張側の表示ロジックも変えたなら deploy も必要。

### 9-4. 開発ストア vs ステージング（POS Pro）

開発ストアは POS に制限がある。**POS 実機検証は POS Pro が有効なストア**で行う。タイル配置は Admin の POS エディタから（§6-1）。

### 9-5. デバッグ Tips

- **Admin API を実トークンで直叩き**して検証（セッション DB からトークンを取り出す）:
  ```bash
  sqlite3 prisma/dev.sqlite "SELECT accessToken FROM Session LIMIT 1;"
  ```
- **`shopify app dev`/CLI の `store execute -j`** で在庫確認。注意: `-j` の JSON は GraphQL の `data` がトップレベルに来る（`.data.field` ではなく `.field` から jq する）。
- **サーバログは `/tmp/backend.log`**。`draftOrderCreate` の userError 文言（例: タグ 40 字超）はここで確定できる。本ルートは非 PII の userError を**レスポンス本文にも含める**ので、ログが取れない環境でも自己診断できる。

---

## 10. その他 AI が知っておくべき設計判断・落とし穴

- **API バージョンは全 2026-04 に統一**（`shopify.app.toml` / `.graphqlrc.ts` / 各拡張 `shopify.extension.toml` / package）。`@shopify/ui-extensions` は 2026.4.x。混在させると検証が通らない。
- **`purchasingEntity`（draftOrderCreate での顧客紐付け）は使わない。** new customer accounts では userError → 422 を招きうるし、EC カートを伴わない申請も想定する。代わりに顧客の数値 ID / 氏名 / 電話 / メールを customAttribute に保持し、表示名・連絡先は `fetchCustomerInfo`（best-effort・失敗は致命としない）で Customer から解決する。
- **`draftOrderUpdate` の customAttributes は全置換**（merge ではない）。更新時は必ず `attrMapFromReservation` で既存属性を復元してから差分を足す。これを怠ると customerId 等が欠落する。
- **冪等性は三層:**
  1. `findByIdem`（作成前の重複検出。新ハッシュタグ ＋ 旧全長タグの OR で後方互換）。
  2. `inventoryMoveQuantities @idempotent(key:)`（在庫移動の二重実行を no-op に）。
  3. `linkOrder` の再配信ガード（`reservation.orderId !== orderGid` のときだけ更新）。
- **通知は Shopify Flow に委譲。** `draftOrderInvoiceSend` は使わない。`pickup-status:reserved`（および `expired`）タグの付与を Flow の「タグ追加」トリガにして通知を送る。再通知は `setStatus("reserved")` でタグを付け直して再発火させる。
- **PII をログに出さない。** ログに出すのは冪等キー / 予約番号 / draft id / location id まで。氏名・メール・電話はレスポンス本文（スタッフの本人確認用）には載せるがログには出さない。
- **POS は別 Order を作る**（`draftOrderComplete` 不使用）。そのため取置き Draft の `node.order` は基本 null。`orders/create` webhook の `admin_graphql_api_id` を `pickup_order_id` に保存して紐づける。
- **Draft は完了後も削除しない**（v11 撤回の教訓・§4-6）。Draft が予約レコードそのものなので、削除＝完了履歴の消失。
- **在庫ドリフトの不変条件**: `on_hand = available + reserved (+ committed)`。Reserve は CAS で同時更新を弾き、Release/Expire は clamp で寛容に戻す。release 漏れ（reserved のまま決済）は webhook が検知して在庫を戻し ALERT ログを出す。
- **タグ 40 字制限**（§3-2）。冪等キーはハッシュ索引タグ＋完全値 customAttribute の二段持ち。

---

## 11. ファイル構成マップ（再現の足場）

```
pos-in-store-reservation/
├── shopify.app.toml                 # scopes / webhooks / app_proxy / application_url
├── prisma/schema.prisma             # Session モデルのみ（予約テーブルは無い）
├── app/
│   ├── shopify.server.ts            # @shopify/shopify-app-remix セットアップ
│   ├── lib/pickup/
│   │   ├── constants.ts             # TAG/ATTR/idemHash/reason/referenceDocumentUri/ID変換
│   │   ├── admin.server.ts          # adminGraphql<T>（data 抽出・errors を例外化）
│   │   ├── errors.ts                # GraphqlError/UserError/Insufficient.../Conflict
│   │   ├── ui.ts                    # statusLabel/statusTone/formatJst/reservationPath
│   │   ├── draft.server.ts          # Draft = 予約レコードの全 CRUD（GraphQL 集約）
│   │   ├── inventory.server.ts      # available↔reserved 移動（CAS / @idempotent）
│   │   ├── locations.server.ts      # shop config(metafield) / variant 在庫 / ロケーション
│   │   ├── release.server.ts        # reserved→available 戻しの共通処理
│   │   └── sweep.server.ts          # 期限切れ回収コア（runExpireSweep）
│   └── routes/
│       ├── reservations.tsx                              # App Proxy POST 予約作成（STEP1-8）
│       ├── locations.tsx                                 # App Proxy GET ロケーション別在庫
│       ├── apps.pickup.reservations.list.tsx             # POS GET 一覧（JWT+CORS, toDto）
│       ├── apps.pickup.reservations.$draftId.release.tsx # POS POST 引取り（JWT+CORS）
│       ├── webhooks.orders.create.tsx                    # 完了化＋注文紐付け（HMAC）
│       ├── jobs.expire-sweep.tsx                         # 期限切れ job（共有シークレット）
│       ├── app.tsx                                       # 埋め込みシェル（AppProvider/NavMenu）
│       ├── app._index.tsx                                # Admin 一覧（フィルタ/ページング）
│       ├── app.reservations.$id.tsx                      # Admin 詳細＋操作＋注文リンク
│       └── app.settings.tsx                              # 対象店舗/保持時間/手動 sweep
└── extensions/
    ├── pickup-form/                 # Theme App Extension（type=theme）
    │   ├── shopify.extension.toml
    │   └── blocks/store_pickup_form.liquid   # PDP 取置きフォーム（ログイン顧客限定）
    └── pickup-home/                 # POS UI Extension（Preact, 2026-04）
        ├── shopify.extension.toml   # tile + modal の 2 ターゲット
        └── src/
            ├── Tile.jsx             # ホームタイル → presentModal()
            ├── Modal.jsx            # 引取り一覧（ロケーション絞り/グループ化/一括投入）
            └── config.js            # APP_URL ハードコード + listUrl/releaseUrl
```

### 推奨実装順

1. **scaffold**: `shopify app init`（Remix preset）→ POS UI 拡張・Theme App Extension を CLI で生成（手作りしない）。
2. **scopes / app_proxy / webhooks** を `shopify.app.toml` に設定。
3. **`lib/pickup/constants.ts`**（タグ・属性・ハッシュ・ID 変換の土台）。
4. **`admin.server.ts` / `errors.ts` / `ui.ts`**（共通基盤）。
5. **`draft.server.ts` / `inventory.server.ts` / `locations.server.ts`**（GraphQL ロジック。Shopify Dev MCP の `validate_graphql_codeblocks` で検証）。
6. **App Proxy ルート**（`locations.tsx` → `reservations.tsx`）。
7. **POS ルート**（`...list.tsx` → `...release.tsx`、JWT + CORS）と **POS 拡張**（`Tile.jsx` / `Modal.jsx` / `config.js`）。
8. **`release.server.ts` / `sweep.server.ts`** と **webhook / job ルート**。
9. **Admin 画面**（`app.tsx` / `app._index.tsx` / `app.reservations.$id.tsx` / `app.settings.tsx`）。
10. **Flow** で reserved/expired タグ起点の通知と毎時 sweep を組む。

---

## 再現チェックリスト（自己点検用）

- [ ] アクセススコープを設定したか（products/inventory/locations/draft_orders/orders/customers の read/write）。
- [ ] App Proxy の 3 経路を**それぞれ正しい認証**で実装したか（A: `authenticate.public.appProxy` 署名 / B: `authenticate.admin` JWT+CORS / C: webhook HMAC・共有シークレット）。
- [ ] 顧客は**署名済み `logged_in_customer_id` のみ**から取り、クライアント入力を信用していないか。
- [ ] タグ 40 字制限を回避したか（冪等キーは `idemHash` タグ ＋ 完全値 customAttribute）。
- [ ] 在庫移動が **`@idempotent` ＋ Reserve は CAS**、Release/Expire は clamp で寛容になっているか。
- [ ] `available` 以外を動かす側に `ledgerDocumentUri` を渡しているか（両側 null で 422 を回避）。
- [ ] `draftOrderUpdate` の customAttributes 全置換に対し、既存属性を復元してから更新しているか。
- [ ] **完了時に Draft を削除していない**か（履歴保持・`pickup_order_id` で注文紐付け）。
- [ ] 複数取置きの `pickup_idem` を**カンマ連結で累積**し、webhook 側で分割しているか。
- [ ] POS モーダルが**現在ロケーションで絞り込み**、取得不可時は全件表示（安全側）になっているか。
- [ ] `application_url` / `app_proxy.url` / POS `config.js` の `APP_URL` の **3 点が一致**しているか。
- [ ] 専用 DB を作らず **Draft Order を予約レコード**として使っているか（Prisma は Session のみ）。
- [ ] PII をログに出していないか（冪等キー / 予約番号 / location id まで）。
- [ ] API バージョンが**全 2026-04**に統一されているか。

---

*このガイドは完成済みアプリ（v12 時点・実機 E2E 通過・在庫ドリフト無し）の実コードを逐語引用して作成した。実装の単一の正は常にソースコードにある。*
