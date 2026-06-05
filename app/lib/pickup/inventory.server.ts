import { adminGraphql, type AdminGraphqlClient } from "./admin.server";
import { InventoryConflictError, UserError } from "./errors";
import {
  moveIdemKey,
  referenceDocumentUri,
  RELEASE_REASON,
  RESERVE_REASON,
} from "./constants";

// inventoryMoveQuantities: Shopify Dev MCP で ✅ 検証済み。
// 2026-04 では @idempotent(key:) が必須。単一ロケーション内で available <-> reserved を移動。
const M_MOVE = `#graphql
  mutation Move($input: InventoryMoveQuantitiesInput!, $idem: String!) {
    inventoryMoveQuantities(input: $input) @idempotent(key: $idem) {
      inventoryAdjustmentGroup { id createdAt reason referenceDocumentUri }
      userErrors { field message code }
    }
  }`;

type MoveUserError = {
  field?: string[] | null;
  message: string;
  code?: string | null;
};

interface ChangeState {
  locationId: string;
  name: "available" | "reserved";
  /** compare-and-set。期待現在値。null なら CAS なし。 */
  changeFromQuantity: number | null;
}

async function move(
  admin: AdminGraphqlClient,
  params: {
    inventoryItemId: string;
    quantity: number;
    from: ChangeState;
    to: ChangeState;
    reason: string;
    referenceDocumentUri: string;
    idemKey: string;
  },
): Promise<{ ok: true; adjustmentGroupId: string } | { ok: false; userErrors: MoveUserError[] }> {
  // Shopify 仕様: available 以外の状態（reserved 等）を移動する側は
  // ledgerDocumentUri が必須（"A ledger document URI is required except when
  // adjusting available." / code INVALID_QUANTITY_DOCUMENT）。
  // available 側は null 可。両側 null だと 422 になる。
  const ledgerFor = (name: ChangeState["name"]): string | null =>
    name === "available" ? null : params.referenceDocumentUri;

  const data = await adminGraphql<{
    inventoryMoveQuantities: {
      inventoryAdjustmentGroup: { id: string } | null;
      userErrors: MoveUserError[];
    };
  }>(admin, M_MOVE, {
    idem: params.idemKey,
    input: {
      reason: params.reason,
      referenceDocumentUri: params.referenceDocumentUri,
      changes: [
        {
          quantity: params.quantity,
          inventoryItemId: params.inventoryItemId,
          from: {
            locationId: params.from.locationId,
            name: params.from.name,
            ledgerDocumentUri: ledgerFor(params.from.name),
            changeFromQuantity: params.from.changeFromQuantity,
          },
          to: {
            locationId: params.to.locationId,
            name: params.to.name,
            ledgerDocumentUri: ledgerFor(params.to.name),
            changeFromQuantity: params.to.changeFromQuantity,
          },
        },
      ],
    },
  });

  const result = data.inventoryMoveQuantities;
  if (result.userErrors.length > 0) {
    return { ok: false, userErrors: result.userErrors };
  }
  return { ok: true, adjustmentGroupId: result.inventoryAdjustmentGroup!.id };
}

/** userErrors が CAS（数量変動）由来かを判定する。 */
function looksLikeConflict(errors: MoveUserError[]): boolean {
  return errors.some((e) => {
    const hay = `${e.code ?? ""} ${e.message}`.toLowerCase();
    return (
      hay.includes("changefromquantity") ||
      hay.includes("changed") ||
      hay.includes("quantity") ||
      hay.includes("conflict")
    );
  });
}

/**
 * available -> reserved（取置きロック）。compare-and-set で在庫変動を検知。
 * 衝突したら refetch で最新値を取り直して 1 回だけ再試行する。
 */
export async function reserveAtLocation(
  admin: AdminGraphqlClient,
  params: {
    inventoryItemId: string;
    locationId: string; // GID
    quantity: number;
    draftLegacyId: string;
    expected: { available: number; reserved: number };
    /** CAS 衝突時に最新の {available, reserved} を取り直すコールバック。 */
    refetch?: () => Promise<{ available: number; reserved: number }>;
  },
): Promise<{ adjustmentGroupId: string }> {
  const idemKey = moveIdemKey(params.draftLegacyId, "reserve");
  const ref = referenceDocumentUri(params.draftLegacyId, "reserve");
  let expected = params.expected;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await move(admin, {
      inventoryItemId: params.inventoryItemId,
      quantity: params.quantity,
      reason: RESERVE_REASON,
      referenceDocumentUri: ref,
      idemKey,
      from: {
        locationId: params.locationId,
        name: "available",
        changeFromQuantity: expected.available,
      },
      to: {
        locationId: params.locationId,
        name: "reserved",
        changeFromQuantity: expected.reserved,
      },
    });

    if (result.ok) return { adjustmentGroupId: result.adjustmentGroupId };

    const conflict = looksLikeConflict(result.userErrors);
    const canRetry = attempt === 0 && conflict && !!params.refetch;
    if (canRetry) {
      expected = await params.refetch!();
      continue;
    }
    if (conflict) throw new InventoryConflictError();
    throw new UserError("inventoryMoveQuantities (reserve) failed", result.userErrors);
  }

  // 到達しない（ループ内で必ず return/throw）
  throw new InventoryConflictError();
}

/**
 * reserved -> available（引取り/期限切れ/キャンセルの在庫戻し）。
 * 二重 release / expire 競合に強いよう、現在 reserved に収まる量だけ戻す。
 * CAS は使わない（戻し処理は寛容に。@idempotent で二重実行は no-op）。
 */
export async function releaseInventory(
  admin: AdminGraphqlClient,
  params: {
    inventoryItemId: string;
    locationId: string; // GID
    quantity: number;
    currentReserved: number;
    currentAvailable: number;
    draftLegacyId: string;
    action: "release" | "expire";
  },
): Promise<{ adjustmentGroupId: string | null; movedQuantity: number }> {
  const moveQty = Math.min(params.quantity, Math.max(0, params.currentReserved));
  if (moveQty <= 0) {
    // すでに戻し済み（reserved が無い）。冪等な成功とみなす。
    return { adjustmentGroupId: null, movedQuantity: 0 };
  }

  const idemKey = moveIdemKey(params.draftLegacyId, params.action);
  const ref = referenceDocumentUri(params.draftLegacyId, params.action);

  const result = await move(admin, {
    inventoryItemId: params.inventoryItemId,
    quantity: moveQty,
    reason: RELEASE_REASON,
    referenceDocumentUri: ref,
    idemKey,
    from: {
      locationId: params.locationId,
      name: "reserved",
      changeFromQuantity: null,
    },
    to: {
      locationId: params.locationId,
      name: "available",
      changeFromQuantity: null,
    },
  });

  if (!result.ok) {
    // reserved が他処理で先に戻された等。戻すべき在庫が無いだけなら成功扱い。
    if (looksLikeConflict(result.userErrors)) {
      return { adjustmentGroupId: null, movedQuantity: 0 };
    }
    throw new UserError("inventoryMoveQuantities (release) failed", result.userErrors);
  }
  return { adjustmentGroupId: result.adjustmentGroupId, movedQuantity: moveQty };
}
