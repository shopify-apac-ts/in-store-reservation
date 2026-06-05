# 店舗取置きアプリ（in-store pickup reservation）

EC（オンラインストア）で **決済なし**の店舗取置きを申し込み、在庫を確保し、来店時に POS で店頭決済する Shopify Custom App。Remix + TypeScript 製。

> 業務フロー: **EC で取置き申請（決済なし）→ 在庫 `available→reserved` ロック → 来店して POS で引取り＋店頭決済（`reserved→available`）→ 期限切れは自動で在庫を戻す。**

実装の全体像・データモデル・処理フロー・運用手順を 1 本にまとめた再現ガイドが [`docs/pickup-app-reproduction-guide.md`](docs/pickup-app-reproduction-guide.md) にあります。**詳細はそちらが正です。** この README は概要と起動手順に絞ります。

---

## 設計の核

- **Draft Order そのものが「予約レコード」。** 予約専用の DB テーブルは持たない（Prisma/SQLite には OAuth セッション用の `Session` モデルのみ）。
- **状態 = tags / メタ = customAttributes / 在庫 = `inventoryMoveQuantities`。** 状態遷移は Draft Order のタグ（`pickup-status:<reserved|released|completed|expired|cancelled>`）、付帯情報は customAttributes、在庫は `available ↔ reserved` の移動で表現する（`on_hand` は動かさない）。
- **顧客は署名済み `logged_in_customer_id` だけを信用する。** クライアントから送られる顧客情報は信用しない。
- **Shopify API は全て `2026-04` に統一。** `@shopify/ui-extensions` は `2026.4.x`。

---

## 構成（4 コンポーネント）

| コンポーネント | 実体 | 役割 |
|---|---|---|
| **EC テーマ拡張** | [`extensions/pickup-form/`](extensions/pickup-form/)（Theme App Extension / Liquid block） | PDP に取置きフォームを描画。ロケーション別在庫を取得し、取置き申請を送信。ログイン顧客限定。 |
| **Remix バックエンド** | [`app/`](app/)（`@shopify/shopify-app-remix`） | App Proxy ルート（予約作成・在庫表示・一覧・引取り）、Admin 埋め込み画面、`orders/create` webhook、期限切れ job。GraphQL ロジックは [`app/lib/pickup/`](app/lib/pickup/) に集約。 |
| **POS UI 拡張** | [`extensions/pickup-home/`](extensions/pickup-home/)（Preact, `pos.home.tile.render` + `pos.home.modal.render`） | ホームタイル → モーダルで引取り待ち一覧。引取り（在庫戻し＋カート復元）＋複数取置きの一括決済の起点。 |
| **Shopify プラットフォーム** | Draft Orders / Inventory / Customers / Flow / Orders | 予約レコードの保管庫（Draft Order）、在庫台帳、顧客情報、通知（Flow）、決済（Order）。 |

通信経路（App Proxy）と 3 つの認証方式（App Proxy 署名 HMAC / POS セッション JWT + CORS / Webhook HMAC / 共有シークレット）は再現ガイド §2 を参照。

### アクセススコープ

```
read_products, read_inventory, write_inventory, read_locations,
read_draft_orders, write_draft_orders, read_orders, write_orders,
read_customers, write_customers
```

---

## ディレクトリ

```
app/
├── lib/pickup/                       # GraphQL ロジックの集約
│   ├── constants.ts                  # タグ/属性/idemHash/reason/ID変換
│   ├── draft.server.ts               # Draft = 予約レコードの CRUD
│   ├── inventory.server.ts           # available↔reserved 移動（CAS / @idempotent）
│   ├── locations.server.ts           # shop config(metafield) / variant 在庫
│   ├── release.server.ts             # reserved→available 戻し
│   ├── sweep.server.ts               # 期限切れ回収（runExpireSweep）
│   ├── errors.ts / ui.ts / admin.server.ts
└── routes/
    ├── reservations.tsx              # App Proxy POST 予約作成
    ├── locations.tsx                 # App Proxy GET ロケーション別在庫
    ├── apps.pickup.reservations.list.tsx              # POS GET 一覧（JWT+CORS）
    ├── apps.pickup.reservations.$draftId.release.tsx  # POS POST 引取り（JWT+CORS）
    ├── webhooks.orders.create.tsx    # 完了化＋注文紐付け（HMAC）
    ├── jobs.expire-sweep.tsx         # 期限切れ job（共有シークレット）
    └── app*.tsx                      # Admin 埋め込み（一覧/詳細/設定）
extensions/
├── pickup-form/                      # EC theme app extension
└── pickup-home/                      # POS UI extension（tile + modal）
prisma/schema.prisma                  # Session モデルのみ（予約テーブルは無い）
shopify.app.toml                      # scopes / webhooks / app_proxy
docs/pickup-app-reproduction-guide.md # 再現ガイド（実装の正）
```

---

## セットアップ

### 前提

- Node.js / pnpm
- Shopify CLI（`npm install -g @shopify/cli@latest`）
- **POS Pro 有効のテストストア**（POS 実機検証には開発ストアではなく POS Pro が必要）

### 依存インストール & DB 初期化

```shell
pnpm install
pnpm exec prisma migrate deploy   # または package.json の setup スクリプト
```

### 環境変数

`.env.example` を `.env` にコピーして設定する（`.env` はコミット禁止）:

```
PICKUP_EXPIRE_SWEEP_SECRET=   # /jobs/expire-sweep を保護する共有シークレット（openssl rand -hex 32）
PICKUP_SHOP=                  # sweep で shop 省略時のデフォルト対象ストア（例: your-store.myshopify.com）
```

---

## 開発・運用

> ⚠️ **POS 実機検証では `shopify app dev` を使わない。** 常駐バックエンドが必要なため、`@remix-run/serve` を常駐させ、別途 cloudflared で**永続トンネル**を張る。詳細は再現ガイド §9。

### バックエンド起動（常駐）

```shell
# 1. ビルド
pnpm exec remix vite:build

# 2. 常駐起動（:3000）
nohup env PORT=3000 node --env-file=.env \
  "$(node -e "console.log(require.resolve('@remix-run/serve/dist/cli.js'))")" \
  ./build/server/index.js > /tmp/backend.log 2>&1 & disown

# 3. ヘルスチェック（200 が返れば OK）
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/
```

### バックエンドの更新（`app/**` を変更したとき）

```shell
pnpm exec remix vite:build        # 再ビルド
lsof -ti tcp:3000 | xargs kill    # 旧プロセス停止 → 上の手順 2 で再起動
```

### deploy の境界（重要）

| 変更対象 | 反映方法 |
|---|---|
| **拡張（`extensions/**`）/ `*.toml`** | `shopify app deploy`（Shopify に push） |
| **Remix バックエンド（`app/**`）** | `remix vite:build` + :3000 再起動（deploy には**含まれない**） |

DTO（例: list ルートの `toDto`）を変えると POS が読む形が変わるため**サーバ再起動が必要**。

### URL カップリングに注意

`application_url` / `app_proxy.url`（`shopify.app.toml`）と POS 拡張の `extensions/pickup-home/src/config.js` の `APP_URL` の **3 点を一致**させること。トンネル URL が変わると POS 拡張が壊れる。

### POS タイルの配置

Admin の POS エディタ（販売チャネル → Point of Sale → 設定 → カスタマイズ「POSアプリ」 → スマートグリッド → ⊕タイル追加 → アプリ → 保存）から配置する。POS デバイス側の「タイル追加 → アプリ」では配置できない。

### 期限切れ sweep

`POST /jobs/expire-sweep`（共有シークレットで保護）。通常は Shopify Flow の「Scheduled time → Send HTTP request」で毎時起動する。Admin 設定画面の「期限切れを今すぐ処理」からも手動実行可。

---

## ドキュメント

- **[再現ガイド `docs/pickup-app-reproduction-guide.md`](docs/pickup-app-reproduction-guide.md)** — 設計・全コンポーネント実装・処理フロー・運用ノウハウ・落とし穴・再現チェックリスト（実コード逐語収録）。
- [`@shopify/shopify-app-remix` ドキュメント](https://shopify.dev/docs/api/shopify-app-remix)
- [App Proxy](https://shopify.dev/docs/apps/build/online-store/display-dynamic-data) / [POS UI Extensions](https://shopify.dev/docs/api/pos-ui-extensions)
