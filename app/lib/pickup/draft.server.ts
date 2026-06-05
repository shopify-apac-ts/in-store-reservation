import { createHash } from "node:crypto";
import { adminGraphql, type AdminGraphqlClient } from "./admin.server";
import { UserError } from "./errors";
import {
  ALL_STATUS_TAGS,
  ATTR,
  IDEM_TAG_PREFIX,
  idemTag,
  LOCATION_TAG_PREFIX,
  locationGidFromLegacy,
  locationTag,
  legacyIdFromGid,
  type PickupStatus,
  STATUS_TAG_PREFIX,
  statusTag,
  TAG_BASE,
} from "./constants";

// ---- GraphQL（すべて Shopify Dev MCP で ✅ 検証済み）----

const M_CREATE = `#graphql
  mutation CreatePickupDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        legacyResourceId
        name
        tags
        note2
        email
        customer { id legacyResourceId displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
        customAttributes { key value }
        lineItems(first: 20) {
          edges { node { id quantity variant { id inventoryItem { id } } } }
        }
      }
      userErrors { field message }
    }
  }`;

// 顧客の表示名 / 連絡先を取得する（POS 一覧の宛名・本人確認補助に使う）。
// purchasingEntity を使わない代わりに、ここで取得した値を customAttribute に保存する。
const Q_CUSTOMER = `#graphql
  query PickupCustomer($id: ID!) {
    customer(id: $id) {
      id
      legacyResourceId
      displayName
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
    }
  }`;

const M_DELETE = `#graphql
  mutation DeleteDraft($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }`;

const M_UPDATE = `#graphql
  mutation UpdateDraft($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { id tags customAttributes { key value } }
      userErrors { field message }
    }
  }`;

const M_TAGS_ADD = `#graphql
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`;

const M_TAGS_REMOVE = `#graphql
  mutation RemoveTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`;

const Q_LIST = `#graphql
  query ReservationsByQuery($q: String!, $first: Int!, $after: String) {
    draftOrders(first: $first, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          legacyResourceId
          name
          tags
          createdAt
          updatedAt
          email
          note2
          customer { id legacyResourceId displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
          totalPriceSet { shopMoney { amount currencyCode } }
          customAttributes { key value }
          lineItems(first: 20) { edges { node { id title quantity variant { id inventoryItem { id } } } } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const Q_NODE = `#graphql
  query DraftReservationNode($id: ID!) {
    draftOrder(id: $id) {
      id
      legacyResourceId
      name
      tags
      email
      note2
      status
      customer { id legacyResourceId displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
      customAttributes { key value }
      order { id }
      lineItems(first: 50) {
        edges { node { id title quantity variant { id title inventoryItem { id } } } }
      }
    }
  }`;

// ---- 型 ----

export interface ReservationLineItem {
  id: string;
  title?: string;
  quantity: number;
  variantId: string | null;
  inventoryItemId: string | null;
}

export interface Reservation {
  id: string; // DraftOrder GID
  legacyResourceId: string;
  name: string;
  status: PickupStatus | null;
  tags: string[];
  locationId: string | null; // GID
  legacyLocationId: string | null;
  locationName: string | null;
  expiresAt: string | null; // ISO8601
  isExpired: boolean;
  reservationNo: string | null;
  qty: number | null;
  variantId: string | null;
  customerId: string | null; // 顧客 legacyResourceId（数値文字列）
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

interface RawDraftNode {
  id: string;
  legacyResourceId: string;
  name: string;
  tags: string[];
  email?: string | null;
  note2?: string | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  order?: { id: string } | null;
  customer?: {
    id: string;
    legacyResourceId: string;
    displayName?: string | null;
    defaultEmailAddress?: { emailAddress?: string | null } | null;
    defaultPhoneNumber?: { phoneNumber?: string | null } | null;
  } | null;
  totalPriceSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
  customAttributes: Array<{ key: string; value: string | null }>;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        title?: string;
        quantity: number;
        variant: { id: string; title?: string; inventoryItem: { id: string } | null } | null;
      };
    }>;
  };
}

// ---- ヘルパ ----

/** idempotencyKey から決定的な受取番号 R-XXXXXX を導出する（連番カウンタ不要）。 */
export function reservationNoFromIdem(idempotencyKey: string): string {
  const h = createHash("sha1").update(idempotencyKey).digest("hex");
  return `R-${h.slice(0, 6).toUpperCase()}`;
}

function attrMap(attrs: Array<{ key: string; value: string | null }>) {
  const m = new Map<string, string>();
  for (const a of attrs) if (a.value != null) m.set(a.key, a.value);
  return m;
}

function tagValue(tags: string[], prefix: string): string | null {
  const t = tags.find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : null;
}

function parseStatus(tags: string[]): PickupStatus | null {
  const v = tagValue(tags, STATUS_TAG_PREFIX);
  return (v as PickupStatus) ?? null;
}

function parseReservation(node: RawDraftNode): Reservation {
  const tags = node.tags ?? [];
  const attrs = attrMap(node.customAttributes ?? []);

  const legacyLoc = tagValue(tags, LOCATION_TAG_PREFIX);
  const attrLocId = attrs.get(ATTR.locationId) ?? null;
  const locationId =
    attrLocId ?? (legacyLoc ? locationGidFromLegacy(legacyLoc) : null);

  const expiresAt = attrs.get(ATTR.expiresAt) ?? null;
  const isExpired = expiresAt ? Date.parse(expiresAt) < Date.now() : false;

  const qtyAttr = attrs.get(ATTR.qty);
  const qty = qtyAttr ? Number(qtyAttr) : null;

  return {
    id: node.id,
    legacyResourceId: node.legacyResourceId,
    name: node.name,
    status: parseStatus(tags),
    tags,
    locationId,
    legacyLocationId: legacyLoc ?? (locationId ? legacyIdFromGid(locationId) : null),
    locationName: attrs.get(ATTR.locationName) ?? null,
    expiresAt,
    isExpired,
    reservationNo: attrs.get(ATTR.reservationNo) ?? null,
    qty: qty != null && Number.isFinite(qty) ? qty : null,
    variantId: attrs.get(ATTR.variantId) ?? null,
    customerId: node.customer?.legacyResourceId ?? attrs.get(ATTR.customerId) ?? null,
    email:
      node.customer?.defaultEmailAddress?.emailAddress ?? node.email ?? null,
    customerName:
      node.customer?.displayName ?? attrs.get(ATTR.customerName) ?? null,
    customerPhone:
      node.customer?.defaultPhoneNumber?.phoneNumber ??
      attrs.get(ATTR.customerPhone) ??
      null,
    // 完全な idempotencyKey は customAttribute に保持する（タグはハッシュ索引）。
    // 旧データ（タグに全長を格納）でも tagValue フォールバックで読める。
    idempotencyKey: attrs.get(ATTR.idem) ?? tagValue(tags, IDEM_TAG_PREFIX),
    note: node.note2 ?? null,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    // POS は取置き Draft とは別に Order を作る（draftOrderComplete 不使用）ため
    // node.order は基本 null。完了時に webhook が customAttribute へ書く GID を読む。
    orderId: node.order?.id ?? attrs.get(ATTR.orderId) ?? null,
    totalPrice: node.totalPriceSet
      ? {
          amount: node.totalPriceSet.shopMoney.amount,
          currencyCode: node.totalPriceSet.shopMoney.currencyCode,
        }
      : null,
    lineItems: node.lineItems.edges.map(({ node: li }) => ({
      id: li.id,
      title: li.title,
      quantity: li.quantity,
      variantId: li.variant?.id ?? null,
      inventoryItemId: li.variant?.inventoryItem?.id ?? null,
    })),
  };
}

function formatExpiryJST(iso: string): string {
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

function buildNote(
  locationName: string,
  expiresAtIso: string,
  reservationNo: string,
): string {
  return `${locationName} 取置き / 期限 ${formatExpiryJST(expiresAtIso)} / 受取番号 ${reservationNo}`;
}

// ---- 公開 API ----

/** 同一 idempotencyKey の既存予約を探す（冪等性）。 */
export async function findByIdem(
  admin: AdminGraphqlClient,
  idempotencyKey: string,
): Promise<Reservation | null> {
  // 新方式（ハッシュ索引タグ）に加え、旧方式（全長タグ）も突合して後方互換を保つ。
  const legacyTag = `${IDEM_TAG_PREFIX}${idempotencyKey}`;
  const q = `tag:'${idemTag(idempotencyKey)}' OR tag:'${legacyTag}'`;
  const data = await adminGraphql<{
    draftOrders: { edges: Array<{ node: RawDraftNode }> };
  }>(admin, Q_LIST, { q, first: 1 });
  const node = data.draftOrders.edges[0]?.node;
  return node ? parseReservation(node) : null;
}

export interface CreatePickupDraftParams {
  variantId: string; // GID
  quantity: number;
  locationId: string; // GID
  locationName: string;
  expiresAtIso: string;
  idempotencyKey: string;
  customerId?: string | null; // 顧客 GID（App Proxy 署名済み logged_in_customer_id 由来）
  email?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
}

/**
 * 顧客の表示名 / 連絡先を best-effort で取得する。
 * 失敗（権限不足・存在しない・new customer accounts 等）は致命としない。
 */
async function fetchCustomerInfo(
  admin: AdminGraphqlClient,
  customerGid: string,
): Promise<{ displayName: string | null; email: string | null; phone: string | null } | null> {
  try {
    const data = await adminGraphql<{
      customer: {
        displayName?: string | null;
        defaultEmailAddress?: { emailAddress?: string | null } | null;
        defaultPhoneNumber?: { phoneNumber?: string | null } | null;
      } | null;
    }>(admin, Q_CUSTOMER, { id: customerGid });
    const c = data.customer;
    if (!c) return null;
    return {
      displayName: c.displayName ?? null,
      email: c.defaultEmailAddress?.emailAddress ?? null,
      phone: c.defaultPhoneNumber?.phoneNumber ?? null,
    };
  } catch {
    return null;
  }
}

/** 取置き Draft Order（= 予約レコード）を作成する。 */
export async function createPickupDraft(
  admin: AdminGraphqlClient,
  p: CreatePickupDraftParams,
): Promise<Reservation> {
  const reservationNo = reservationNoFromIdem(p.idempotencyKey);
  const legacyLoc = legacyIdFromGid(p.locationId);

  const customAttributes: Array<{ key: string; value: string }> = [
    { key: ATTR.reservationNo, value: reservationNo },
    { key: ATTR.locationId, value: p.locationId },
    { key: ATTR.locationName, value: p.locationName },
    { key: ATTR.expiresAt, value: p.expiresAtIso },
    { key: ATTR.qty, value: String(p.quantity) },
    { key: ATTR.variantId, value: p.variantId },
    { key: ATTR.idem, value: p.idempotencyKey },
  ];

  // 顧客の紐付け方針:
  //   purchasingEntity（draftOrderCreate での顧客紐付け）は使わない。
  //   - store-2 の new customer accounts では userError → 422 を招きうる。
  //   - そもそも EC カートを伴わない取置き申請も想定する。
  //   代わりに顧客の数値 ID / 氏名 / 電話 / メールを customAttribute として保持し、
  //   parseReservation がそこから顧客を解決する（POS グルーピング・カート顧客
  //   自動セットの単一情報源）。氏名・連絡先は best-effort で Customer から取得。
  let resolvedEmail = p.email ?? null;
  if (p.customerId) {
    customAttributes.push({
      key: ATTR.customerId,
      value: legacyIdFromGid(p.customerId),
    });
    const info = await fetchCustomerInfo(admin, p.customerId);
    const name = p.customerName ?? info?.displayName ?? null;
    const phone = p.customerPhone ?? info?.phone ?? null;
    resolvedEmail = resolvedEmail ?? info?.email ?? null;
    if (name) customAttributes.push({ key: ATTR.customerName, value: name });
    if (phone) customAttributes.push({ key: ATTR.customerPhone, value: phone });
  } else {
    if (p.customerName) {
      customAttributes.push({ key: ATTR.customerName, value: p.customerName });
    }
    if (p.customerPhone) {
      customAttributes.push({ key: ATTR.customerPhone, value: p.customerPhone });
    }
  }

  const input: Record<string, unknown> = {
    tags: [
      TAG_BASE,
      statusTag("reserved"),
      locationTag(legacyLoc),
      idemTag(p.idempotencyKey),
    ],
    note: buildNote(p.locationName, p.expiresAtIso, reservationNo),
    customAttributes,
    lineItems: [{ variantId: p.variantId, quantity: p.quantity }],
  };
  if (resolvedEmail) input.email = resolvedEmail;

  const data = await adminGraphql<{
    draftOrderCreate: {
      draftOrder: RawDraftNode | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(admin, M_CREATE, { input });

  const { draftOrder, userErrors } = data.draftOrderCreate;
  if (userErrors.length > 0 || !draftOrder) {
    throw new UserError("draftOrderCreate failed", userErrors);
  }
  return parseReservation(draftOrder);
}

export interface ListReservationsResult {
  reservations: Reservation[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** 取置き予約を一覧取得する（任意でステータス絞り込み）。 */
export async function listReservations(
  admin: AdminGraphqlClient,
  opts: { status?: PickupStatus; first?: number; after?: string | null } = {},
): Promise<ListReservationsResult> {
  let q = `tag:'${TAG_BASE}'`;
  if (opts.status) q += ` AND tag:'${statusTag(opts.status)}'`;

  const data = await adminGraphql<{
    draftOrders: {
      edges: Array<{ node: RawDraftNode }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(admin, Q_LIST, {
    q,
    first: opts.first ?? 50,
    after: opts.after ?? null,
  });

  return {
    reservations: data.draftOrders.edges.map((e) => parseReservation(e.node)),
    hasNextPage: data.draftOrders.pageInfo.hasNextPage,
    endCursor: data.draftOrders.pageInfo.endCursor,
  };
}

/** Draft Order GID で 1 件取得する。 */
export async function getReservation(
  admin: AdminGraphqlClient,
  draftId: string,
): Promise<Reservation | null> {
  const data = await adminGraphql<{ draftOrder: RawDraftNode | null }>(
    admin,
    Q_NODE,
    { id: draftId },
  );
  return data.draftOrder ? parseReservation(data.draftOrder) : null;
}

/** ステータスタグを遷移させる（旧ステータス一括除去 -> 新規付与）。 */
export async function setStatus(
  admin: AdminGraphqlClient,
  draftId: string,
  status: PickupStatus,
): Promise<void> {
  const removed = await adminGraphql<{
    tagsRemove: { userErrors: Array<{ field?: string[] | null; message: string }> };
  }>(admin, M_TAGS_REMOVE, { id: draftId, tags: ALL_STATUS_TAGS });
  if (removed.tagsRemove.userErrors.length > 0) {
    throw new UserError("tagsRemove failed", removed.tagsRemove.userErrors);
  }

  const added = await adminGraphql<{
    tagsAdd: { userErrors: Array<{ field?: string[] | null; message: string }> };
  }>(admin, M_TAGS_ADD, { id: draftId, tags: [statusTag(status)] });
  if (added.tagsAdd.userErrors.length > 0) {
    throw new UserError("tagsAdd failed", added.tagsAdd.userErrors);
  }
}

/** 期限を延長/変更する（customAttributes と note を書き換える）。 */
export async function updateExpiry(
  admin: AdminGraphqlClient,
  draftId: string,
  newExpiresAtIso: string,
): Promise<Reservation> {
  const current = await getReservation(admin, draftId);
  if (!current) throw new UserError("reservation not found", []);

  const attrs = (current.tags, attrMapFromReservation(current));
  attrs.set(ATTR.expiresAt, newExpiresAtIso);

  const customAttributes = Array.from(attrs.entries()).map(([key, value]) => ({
    key,
    value,
  }));

  const note =
    current.locationName && current.reservationNo
      ? buildNote(current.locationName, newExpiresAtIso, current.reservationNo)
      : current.note ?? undefined;

  const data = await adminGraphql<{
    draftOrderUpdate: {
      draftOrder: RawDraftNode | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(admin, M_UPDATE, {
    id: draftId,
    input: { customAttributes, ...(note ? { note } : {}) },
  });

  const { draftOrder, userErrors } = data.draftOrderUpdate;
  if (userErrors.length > 0 || !draftOrder) {
    throw new UserError("draftOrderUpdate failed", userErrors);
  }
  // 更新レスポンスは一部フィールドのみなので、現行値とマージして返す。
  return { ...current, expiresAt: newExpiresAtIso, note: note ?? current.note };
}

function attrMapFromReservation(r: Reservation): Map<string, string> {
  const m = new Map<string, string>();
  if (r.reservationNo) m.set(ATTR.reservationNo, r.reservationNo);
  if (r.locationId) m.set(ATTR.locationId, r.locationId);
  if (r.locationName) m.set(ATTR.locationName, r.locationName);
  if (r.expiresAt) m.set(ATTR.expiresAt, r.expiresAt);
  if (r.qty != null) m.set(ATTR.qty, String(r.qty));
  if (r.variantId) m.set(ATTR.variantId, r.variantId);
  if (r.customerId) m.set(ATTR.customerId, r.customerId);
  if (r.customerName) m.set(ATTR.customerName, r.customerName);
  if (r.customerPhone) m.set(ATTR.customerPhone, r.customerPhone);
  if (r.idempotencyKey) m.set(ATTR.idem, r.idempotencyKey);
  if (r.orderId) m.set(ATTR.orderId, r.orderId);
  return m;
}

/**
 * 完了した取置き記録（Draft）に、対応する販売 Order の GID を紐づける。
 *
 * Draft は削除せず残し、`pickup_order_id` customAttribute で対応注文を辿れるように
 * する。draftOrderUpdate の customAttributes は全置換なので、既存属性を
 * attrMapFromReservation で復元してから order だけ足して送る（idempotent）。
 */
export async function linkOrder(
  admin: AdminGraphqlClient,
  reservation: Reservation,
  orderGid: string,
): Promise<void> {
  const attrs = attrMapFromReservation(reservation);
  attrs.set(ATTR.orderId, orderGid);
  const customAttributes = Array.from(attrs.entries()).map(([key, value]) => ({
    key,
    value,
  }));

  const data = await adminGraphql<{
    draftOrderUpdate: {
      draftOrder: RawDraftNode | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(admin, M_UPDATE, { id: reservation.id, input: { customAttributes } });

  const { draftOrder, userErrors } = data.draftOrderUpdate;
  if (userErrors.length > 0 || !draftOrder) {
    throw new UserError("draftOrderUpdate(linkOrder) failed", userErrors);
  }
}

/** Draft Order を削除する。 */
export async function deleteDraft(
  admin: AdminGraphqlClient,
  draftId: string,
): Promise<void> {
  const data = await adminGraphql<{
    draftOrderDelete: {
      deletedId: string | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(admin, M_DELETE, { input: { id: draftId } });
  if (data.draftOrderDelete.userErrors.length > 0) {
    throw new UserError("draftOrderDelete failed", data.draftOrderDelete.userErrors);
  }
}
