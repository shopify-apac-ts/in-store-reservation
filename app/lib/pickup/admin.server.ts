import { GraphqlError } from "./errors";

/**
 * Admin GraphQL クライアントの最小インターフェース。
 * `authenticate.admin(request)` と `authenticate.public.appProxy(request)` の
 * どちらが返す `admin` でも満たす形にしている。
 */
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/**
 * GraphQL を実行し data を返す。トップレベル errors があれば例外を投げる。
 * userErrors は各 mutation 呼び出し側でチェックする（成功/失敗の意味が異なるため）。
 */
export async function adminGraphql<T = unknown>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(
    query,
    variables ? { variables } : undefined,
  );
  const body = (await response.json()) as {
    data?: T;
    errors?: unknown;
  };

  if (body.errors) {
    throw new GraphqlError("GraphQL request returned errors", body.errors);
  }
  if (body.data === undefined || body.data === null) {
    throw new GraphqlError("GraphQL request returned no data", body);
  }
  return body.data;
}
