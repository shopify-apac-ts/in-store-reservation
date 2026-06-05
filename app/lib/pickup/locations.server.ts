import { adminGraphql, type AdminGraphqlClient } from "./admin.server";
import { UserError } from "./errors";
import {
  DEFAULT_HOLD_HOURS,
  legacyIdFromGid,
  MF_ENABLED_LOCATIONS_KEY,
  MF_HOLD_HOURS_KEY,
  QUANTITY_NAMES,
  SHOP_METAFIELD_NAMESPACE,
} from "./constants";

// ---- GraphQL（すべて Shopify Dev MCP の validate_graphql_codeblocks で ✅ 検証済み）----

const Q_SHOP_CONFIG = `#graphql
  query ShopPickupConfig {
    shop {
      id
      name
      enabledLocations: metafield(namespace: "pickup", key: "enabled_locations") { id type value }
      holdHours: metafield(namespace: "pickup", key: "hold_hours") { id type value }
    }
  }`;

const Q_ACTIVE_LOCATIONS = `#graphql
  query ActiveLocations($first: Int!) {
    locations(first: $first, includeInactive: false) {
      edges { node { id name isActive } }
    }
  }`;

const Q_VARIANT_INVENTORY = `#graphql
  query VariantInventory($id: ID!, $names: [String!]!) {
    productVariant(id: $id) {
      id
      title
      displayName
      inventoryItem {
        id
        tracked
        inventoryLevels(first: 50) {
          edges {
            node {
              location { id name isActive }
              quantities(names: $names) { name quantity }
            }
          }
        }
      }
    }
  }`;

const M_SET_METAFIELDS = `#graphql
  mutation SetShopMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value type ownerType }
      userErrors { field message code }
    }
  }`;

// ---- 型 ----

export interface ShopConfig {
  shopId: string;
  shopName: string;
  /** 対象ロケーション GID の配列。null = 未設定（= 全ロケーション対象）。 */
  enabledLocationIds: string[] | null;
  holdHours: number;
}

export interface LocationOption {
  locationId: string; // GID
  legacyLocationId: string;
  name: string;
  available: number;
}

export interface VariantInventory {
  variantId: string;
  title: string;
  displayName: string;
  inventoryItemId: string;
  tracked: boolean;
  levels: Array<{
    locationId: string;
    legacyLocationId: string;
    name: string;
    isActive: boolean;
    available: number;
    reserved: number;
    onHand: number;
  }>;
}

// ---- 実装 ----

function qty(
  quantities: Array<{ name: string; quantity: number }>,
  name: string,
): number {
  return quantities.find((q) => q.name === name)?.quantity ?? 0;
}

export async function getShopConfig(
  admin: AdminGraphqlClient,
): Promise<ShopConfig> {
  const data = await adminGraphql<{
    shop: {
      id: string;
      name: string;
      enabledLocations: { value: string } | null;
      holdHours: { value: string } | null;
    };
  }>(admin, Q_SHOP_CONFIG);

  let enabledLocationIds: string[] | null = null;
  const raw = data.shop.enabledLocations?.value;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        enabledLocationIds = parsed.map(String);
      }
    } catch {
      enabledLocationIds = null;
    }
  }

  const hoursRaw = data.shop.holdHours?.value;
  const holdHours = hoursRaw ? Number(hoursRaw) : DEFAULT_HOLD_HOURS;

  return {
    shopId: data.shop.id,
    shopName: data.shop.name,
    enabledLocationIds,
    holdHours: Number.isFinite(holdHours) ? holdHours : DEFAULT_HOLD_HOURS,
  };
}

export async function listAllLocations(
  admin: AdminGraphqlClient,
): Promise<Array<{ id: string; name: string; isActive: boolean }>> {
  const data = await adminGraphql<{
    locations: { edges: Array<{ node: { id: string; name: string; isActive: boolean } }> };
  }>(admin, Q_ACTIVE_LOCATIONS, { first: 100 });
  return data.locations.edges.map((e) => e.node);
}

export async function getVariantInventory(
  admin: AdminGraphqlClient,
  variantId: string,
): Promise<VariantInventory | null> {
  const data = await adminGraphql<{
    productVariant: {
      id: string;
      title: string;
      displayName: string;
      inventoryItem: {
        id: string;
        tracked: boolean;
        inventoryLevels: {
          edges: Array<{
            node: {
              location: { id: string; name: string; isActive: boolean };
              quantities: Array<{ name: string; quantity: number }>;
            };
          }>;
        };
      };
    } | null;
  }>(admin, Q_VARIANT_INVENTORY, { id: variantId, names: [...QUANTITY_NAMES] });

  const v = data.productVariant;
  if (!v) return null;

  return {
    variantId: v.id,
    title: v.title,
    displayName: v.displayName,
    inventoryItemId: v.inventoryItem.id,
    tracked: v.inventoryItem.tracked,
    levels: v.inventoryItem.inventoryLevels.edges.map(({ node }) => ({
      locationId: node.location.id,
      legacyLocationId: legacyIdFromGid(node.location.id),
      name: node.location.name,
      isActive: node.location.isActive,
      available: qty(node.quantities, "available"),
      reserved: qty(node.quantities, "reserved"),
      onHand: qty(node.quantities, "on_hand"),
    })),
  };
}

/**
 * PDP 用: この variant を取置き可能なロケーション一覧。
 * 「Admin で有効化されたロケーション（未設定なら全店）」 ∩ isActive ∩ available > 0。
 */
export async function enabledLocationsForVariant(
  admin: AdminGraphqlClient,
  variantId: string,
): Promise<{
  variant: VariantInventory | null;
  locations: LocationOption[];
  holdHours: number;
}> {
  const [config, variant] = await Promise.all([
    getShopConfig(admin),
    getVariantInventory(admin, variantId),
  ]);

  if (!variant || !variant.tracked) {
    return { variant, locations: [], holdHours: config.holdHours };
  }

  const enabledSet = config.enabledLocationIds
    ? new Set(config.enabledLocationIds)
    : null;

  const locations: LocationOption[] = variant.levels
    .filter((lvl) => lvl.isActive && lvl.available > 0)
    .filter((lvl) => (enabledSet ? enabledSet.has(lvl.locationId) : true))
    .map((lvl) => ({
      locationId: lvl.locationId,
      legacyLocationId: lvl.legacyLocationId,
      name: lvl.name,
      available: lvl.available,
    }));

  return { variant, locations, holdHours: config.holdHours };
}

async function getShopGid(admin: AdminGraphqlClient): Promise<string> {
  const data = await adminGraphql<{ shop: { id: string } }>(
    admin,
    `#graphql
      query ShopId { shop { id } }`,
  );
  return data.shop.id;
}

async function setMetafields(
  admin: AdminGraphqlClient,
  metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>,
): Promise<void> {
  const data = await adminGraphql<{
    metafieldsSet: {
      userErrors: Array<{ field?: string[] | null; message: string; code?: string | null }>;
    };
  }>(admin, M_SET_METAFIELDS, { metafields });
  const errs = data.metafieldsSet.userErrors;
  if (errs.length > 0) {
    throw new UserError("metafieldsSet failed", errs);
  }
}

/** 対象ロケーション（GID 配列）を shop metafield に保存。空配列なら全店扱いに戻す。 */
export async function setEnabledLocations(
  admin: AdminGraphqlClient,
  locationGids: string[],
): Promise<void> {
  const shopId = await getShopGid(admin);
  await setMetafields(admin, [
    {
      ownerId: shopId,
      namespace: SHOP_METAFIELD_NAMESPACE,
      key: MF_ENABLED_LOCATIONS_KEY,
      type: "json",
      value: JSON.stringify(locationGids),
    },
  ]);
}

/** 取置き保持時間（時間）を shop metafield に保存。 */
export async function setHoldHours(
  admin: AdminGraphqlClient,
  hours: number,
): Promise<void> {
  const shopId = await getShopGid(admin);
  await setMetafields(admin, [
    {
      ownerId: shopId,
      namespace: SHOP_METAFIELD_NAMESPACE,
      key: MF_HOLD_HOURS_KEY,
      type: "number_integer",
      value: String(Math.max(1, Math.round(hours))),
    },
  ]);
}
