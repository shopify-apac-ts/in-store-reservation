import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enabledLocationsForVariant } from "../lib/pickup/locations.server";
import { GraphqlError } from "../lib/pickup/errors";

/**
 * App Proxy GET
 *   ストアフロント URL : /apps/pickup/locations?variantId=<gid|legacy>
 *   アプリ受信パス     : /locations   ← Shopify が prefix+subpath(/apps/pickup) を剥がして転送するため
 *                        （ゆえにこのルートファイルは locations.tsx）
 *
 * PDP のフォームが叩く。指定 variant を取置き可能なロケーション
 * （Admin で有効化 ∩ isActive ∩ available > 0）と各店の available を返す。
 *
 * 署名(HMAC)検証は authenticate.public.appProxy が自動で行う。
 */

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function normalizeVariantId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("gid://shopify/ProductVariant/")) return trimmed;
  if (/^\d+$/.test(trimmed)) return `gid://shopify/ProductVariant/${trimmed}`;
  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const variantParam =
    url.searchParams.get("variantId") ?? url.searchParams.get("variant_id");
  if (!variantParam) {
    return jsonResponse(
      { error: "missing_variant", message: "variantId is required" },
      { status: 400 },
    );
  }

  const variantId = normalizeVariantId(variantParam);
  if (!variantId) {
    return jsonResponse(
      {
        error: "invalid_variant",
        message: "variantId must be a numeric id or ProductVariant GID",
      },
      { status: 400 },
    );
  }

  try {
    const { variant, locations, holdHours } = await enabledLocationsForVariant(
      admin,
      variantId,
    );
    if (!variant) {
      return jsonResponse({ error: "variant_not_found" }, { status: 404 });
    }

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
  } catch (e) {
    if (e instanceof GraphqlError) {
      console.error("[pickup/locations] graphql error");
      return jsonResponse({ error: "graphql_error" }, { status: 502 });
    }
    console.error(
      "[pickup/locations] error:",
      e instanceof Error ? e.message : "unknown",
    );
    return jsonResponse({ error: "internal_error" }, { status: 500 });
  }
};
