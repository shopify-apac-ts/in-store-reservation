import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  IndexTable,
  Badge,
  Link as PolarisLink,
  Text,
  InlineStack,
  Button,
  EmptyState,
  BlockStack,
  Pagination,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { listReservations } from "../lib/pickup/draft.server";
import { STATUSES, type PickupStatus } from "../lib/pickup/constants";
import {
  statusLabel,
  statusTone,
  formatJst,
  reservationPath,
} from "../lib/pickup/ui";

const PAGE_SIZE = 25;

function parseStatusParam(v: string | null): PickupStatus | undefined {
  return v && (STATUSES as readonly string[]).includes(v)
    ? (v as PickupStatus)
    : undefined;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const status = parseStatusParam(url.searchParams.get("status"));
  const after = url.searchParams.get("after");

  const { reservations, hasNextPage, endCursor } = await listReservations(
    admin,
    { status, first: PAGE_SIZE, after },
  );

  return {
    status: status ?? null,
    reservations: reservations.map((r) => ({
      id: r.id,
      legacyResourceId: r.legacyResourceId,
      name: r.name,
      reservationNo: r.reservationNo,
      status: r.status,
      locationName: r.locationName,
      qty: r.qty,
      expiresAt: r.expiresAt,
      isExpired: r.isExpired,
      customerName: r.customerName,
      createdAt: r.createdAt,
    })),
    hasNextPage,
    endCursor,
  };
};

const FILTERS: Array<{ label: string; value: PickupStatus | "all" }> = [
  { label: "すべて", value: "all" },
  { label: "取置き中", value: "reserved" },
  { label: "引取り対応中", value: "released" },
  { label: "完了", value: "completed" },
  { label: "期限切れ", value: "expired" },
  { label: "キャンセル", value: "cancelled" },
];

export default function ReservationsIndex() {
  const { status, reservations, hasNextPage, endCursor } =
    useLoaderData<typeof loader>();

  const current = status ?? "all";

  const filterUrl = (value: PickupStatus | "all") =>
    value === "all" ? "/app" : `/app?status=${value}`;

  const rows = reservations.map((r, index) => {
    const overdue = r.status === "reserved" && r.isExpired;
    return (
      <IndexTable.Row id={r.id} key={r.id} position={index}>
        <IndexTable.Cell>
          <PolarisLink url={reservationPath(r.legacyResourceId)} removeUnderline>
            <Text as="span" fontWeight="semibold">
              {r.reservationNo ?? r.name}
            </Text>
          </PolarisLink>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>{r.locationName ?? "—"}</IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" numeric>
            {r.qty ?? "—"}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" tone={overdue ? "critical" : undefined}>
            {formatJst(r.expiresAt)}
            {overdue ? "（期限超過）" : ""}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{r.customerName ?? "—"}</IndexTable.Cell>
        <IndexTable.Cell>{formatJst(r.createdAt)}</IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page>
      <TitleBar title="取置き予約" />
      <BlockStack gap="400">
        <InlineStack gap="200">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              url={filterUrl(f.value)}
              pressed={current === f.value}
              variant={current === f.value ? "primary" : "secondary"}
            >
              {f.label}
            </Button>
          ))}
        </InlineStack>

        <Card padding="0">
          {reservations.length === 0 ? (
            <EmptyState
              heading="該当する取置き予約がありません"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>EC の取置きフォームから予約が入るとここに表示されます。</p>
            </EmptyState>
          ) : (
            <IndexTable
              itemCount={reservations.length}
              selectable={false}
              headings={[
                { title: "受取番号" },
                { title: "状態" },
                { title: "店舗" },
                { title: "数量" },
                { title: "期限 (JST)" },
                { title: "お客様" },
                { title: "申込 (JST)" },
              ]}
            >
              {rows}
            </IndexTable>
          )}
        </Card>

        {(hasNextPage || endCursor) && reservations.length > 0 ? (
          <InlineStack align="center">
            <Pagination
              hasPrevious={false}
              hasNext={hasNextPage}
              onNext={() => {
                const base =
                  current === "all" ? "/app?" : `/app?status=${current}&`;
                window.location.assign(`${base}after=${endCursor}`);
              }}
            />
          </InlineStack>
        ) : null}
      </BlockStack>
    </Page>
  );
}
