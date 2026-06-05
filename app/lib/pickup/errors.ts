/**
 * 取置きアプリ共通のエラー型。
 * ルート側で HTTP ステータスへマップする（409 / 422 / 500 など）。
 */

/** GraphQL のトップレベル errors（transport/スキーマ）が返ったとき。 */
export class GraphqlError extends Error {
  constructor(
    message: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = "GraphqlError";
  }
}

/** mutation の userErrors が返ったとき。 */
export class UserError extends Error {
  constructor(
    message: string,
    public readonly userErrors: Array<{
      field?: string[] | null;
      message: string;
      code?: string | null;
    }>,
  ) {
    super(message);
    this.name = "UserError";
  }
}

/**
 * 在庫が足りず予約できない（available < 要求数）。-> HTTP 409 in_stock_changed
 */
export class InsufficientInventoryError extends Error {
  readonly code = "in_stock_changed";
  constructor(
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(
      `Insufficient available inventory: requested ${requested}, available ${available}`,
    );
    this.name = "InsufficientInventoryError";
  }
}

/**
 * compare-and-set（changeFromQuantity）が衝突した。
 * 1 回再取得して再試行し、なお衝突したらルートで 409 に変換する。
 */
export class InventoryConflictError extends Error {
  readonly code = "inventory_conflict";
  constructor(message = "Inventory changed concurrently (CAS conflict)") {
    super(message);
    this.name = "InventoryConflictError";
  }
}
