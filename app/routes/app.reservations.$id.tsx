import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { data } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  Badge,
  Banner,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Button,
  Select,
  Box,
  Divider,
  Link as PolarisLink,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getReservation,
  setStatus,
  updateExpiry,
} from "../lib/pickup/draft.server";
import { releaseReservation } from "../lib/pickup/release.server";
import { getShopConfig } from "../lib/pickup/locations.server";
import { UserError, GraphqlError } from "../lib/pickup/errors";
import { statusLabel, statusTone, formatJst } from "../lib/pickup/ui";

function draftGid(legacyId: string): string {
  return `gid://shopify/DraftOrder/${legacyId}`;
}
function legacyFromGid(gid: string | null): string | null {
  if (!gid) return null;
  const m = gid.match(/(\d+)$/);
  return m ? m[1] : null;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const legacyId = params.id;
  if (!legacyId || !/^\d+$/.test(legacyId)) {
    throw new Response("Not found", { status: 404 });
  }

  const [reservation, config] = await Promise.all([
    getReservation(admin, draftGid(legacyId)),
    getShopConfig(admin),
  ]);
  if (!reservation) {
    throw new Response("Not found", { status: 404 });
  }

  return {
    defaultHoldHours: config.holdHours,
    // 注文リンク用に store ハンドル（admin.shopify.com/store/<handle>）を渡す。
    storeHandle: session.shop.replace(/\.myshopify\.com$/, ""),
    reservation: {
      id: reservation.id,
      legacyResourceId: reservation.legacyResourceId,
      name: reservation.name,
      reservationNo: reservation.reservationNo,
      status: reservation.status,
      locationName: reservation.locationName,
      qty: reservation.qty,
      expiresAt: reservation.expiresAt,
      isExpired: reservation.isExpired,
      email: reservation.email,
      customerName: reservation.customerName,
      customerPhone: reservation.customerPhone,
      note: reservation.note,
      createdAt: reservation.createdAt,
      updatedAt: reservation.updatedAt,
      orderId: reservation.orderId,
      totalPrice: reservation.totalPrice,
      lineItems: reservation.lineItems,
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const legacyId = params.id;
  if (!legacyId || !/^\d+$/.test(legacyId)) {
    return data({ ok: false, message: "不正なIDです。" }, { status: 400 });
  }
  const gid = draftGid(legacyId);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    const reservation = await getReservation(admin, gid);
    if (!reservation) {
      return data({ ok: false, message: "予約が見つかりません。" }, { status: 404 });
    }

    // reserved 以外への破壊的操作はガードする。
    const mutating = ["extend", "release", "cancel", "renotify"];
    if (mutating.includes(intent) && reservation.status !== "reserved") {
      return data(
        {
          ok: false,
          message: `この操作は「取置き中」の予約にのみ実行できます（現在: ${statusLabel(reservation.status)}）。`,
        },
        { status: 422 },
      );
    }

    switch (intent) {
      case "extend": {
        const hours = Number.parseInt(String(form.get("hours") ?? ""), 10);
        if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) {
          return data({ ok: false, message: "延長時間が不正です。" }, { status: 400 });
        }
        const newIso = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        await updateExpiry(admin, gid, newIso);
        return data({
          ok: true,
          message: `期限を ${formatJst(newIso)} に延長しました。`,
        });
      }
      case "release": {
        const { releasedQuantity } = await releaseReservation(
          admin,
          reservation,
          "release",
        );
        await setStatus(admin, gid, "released");
        return data({
          ok: true,
          message: `在庫 ${releasedQuantity} 点を引取り用に戻し、状態を「引取り対応中」にしました。POS で Draft Order を開いて決済してください。`,
        });
      }
      case "cancel": {
        const { releasedQuantity } = await releaseReservation(
          admin,
          reservation,
          "release",
        );
        await setStatus(admin, gid, "cancelled");
        return data({
          ok: true,
          message: `予約をキャンセルし、在庫 ${releasedQuantity} 点を戻しました。`,
        });
      }
      case "renotify": {
        // ステータスタグを付け直して Flow の「タグ追加」トリガを再発火させる。
        await setStatus(admin, gid, "reserved");
        return data({
          ok: true,
          message: "再通知用にステータスタグを付け直しました（Flow が通知を再送します）。",
        });
      }
      default:
        return data({ ok: false, message: "不明な操作です。" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof UserError) {
      console.error(
        "[app.reservations] userErrors:",
        e.userErrors.map((u) => u.code ?? u.message).join(","),
      );
      return data({ ok: false, message: "操作に失敗しました。" }, { status: 422 });
    }
    if (e instanceof GraphqlError) {
      console.error("[app.reservations] graphql error");
      return data({ ok: false, message: "GraphQL エラーが発生しました。" }, { status: 502 });
    }
    console.error(
      "[app.reservations] error:",
      e instanceof Error ? e.message : "unknown",
    );
    return data({ ok: false, message: "予期しないエラーが発生しました。" }, { status: 500 });
  }
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <InlineGrid columns={{ xs: "1fr", sm: "8rem 1fr" }} gap="200">
      <Text as="span" tone="subdued">
        {label}
      </Text>
      <Box>{children}</Box>
    </InlineGrid>
  );
}

export default function ReservationDetail() {
  const { reservation, defaultHoldHours, storeHandle } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state === "submitting";

  const [hours, setHours] = useState(String(defaultHoldHours));

  const isReserved = reservation.status === "reserved";
  const orderLegacy = legacyFromGid(reservation.orderId);
  const orderUrl = orderLegacy
    ? `https://admin.shopify.com/store/${storeHandle}/orders/${orderLegacy}`
    : null;

  return (
    <Page
      backAction={{ content: "予約一覧", url: "/app" }}
      title={reservation.reservationNo ?? reservation.name}
      titleMetadata={
        <Badge tone={statusTone(reservation.status)}>
          {statusLabel(reservation.status)}
        </Badge>
      }
      subtitle={`Draft ${reservation.name}`}
    >
      <TitleBar title={reservation.reservationNo ?? reservation.name} />
      <BlockStack gap="400">
        {actionData?.message ? (
          <Banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </Banner>
        ) : null}

        {isReserved && reservation.isExpired ? (
          <Banner tone="warning">
            この予約は期限を超過しています。期限切れ処理（在庫戻し）の対象です。
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              予約内容
            </Text>
            <Field label="受取番号">
              <Text as="span" fontWeight="semibold">
                {reservation.reservationNo ?? "—"}
              </Text>
            </Field>
            <Field label="店舗">{reservation.locationName ?? "—"}</Field>
            <Field label="数量">
              <Text as="span" numeric>
                {reservation.qty ?? "—"}
              </Text>
            </Field>
            <Field label="商品">
              {reservation.lineItems.length > 0
                ? reservation.lineItems
                    .map((li) => `${li.title ?? "商品"} ×${li.quantity}`)
                    .join(", ")
                : "—"}
            </Field>
            <Field label="期限 (JST)">
              <Text
                as="span"
                tone={
                  isReserved && reservation.isExpired ? "critical" : undefined
                }
              >
                {formatJst(reservation.expiresAt)}
              </Text>
            </Field>
            <Field label="金額">
              {reservation.totalPrice
                ? `${reservation.totalPrice.amount} ${reservation.totalPrice.currencyCode}`
                : "—"}
            </Field>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              お客様
            </Text>
            <Field label="お名前">{reservation.customerName ?? "—"}</Field>
            <Field label="メール">{reservation.email ?? "—"}</Field>
            <Field label="電話">{reservation.customerPhone ?? "—"}</Field>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              メタ
            </Text>
            <Field label="申込 (JST)">{formatJst(reservation.createdAt)}</Field>
            <Field label="更新 (JST)">{formatJst(reservation.updatedAt)}</Field>
            <Field label="メモ">{reservation.note ?? "—"}</Field>
            <Field label="注文">
              {orderUrl ? (
                <PolarisLink url={orderUrl} target="_blank">
                  {`注文 #${orderLegacy} を開く`}
                </PolarisLink>
              ) : (
                "—"
              )}
            </Field>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              操作
            </Text>
            {!isReserved ? (
              <Text as="p" tone="subdued">
                「取置き中」の予約に対してのみ操作できます。
              </Text>
            ) : (
              <BlockStack gap="400">
                <Form method="post">
                  <input type="hidden" name="intent" value="extend" />
                  <input type="hidden" name="hours" value={hours} />
                  <InlineStack gap="300" blockAlign="end" wrap={false}>
                    <Box minWidth="12rem">
                      <Select
                        label="期限を延長"
                        options={[
                          { label: "+24 時間", value: "24" },
                          { label: "+48 時間", value: "48" },
                          { label: "+72 時間", value: "72" },
                          {
                            label: `デフォルト (${defaultHoldHours} 時間)`,
                            value: String(defaultHoldHours),
                          },
                        ]}
                        value={hours}
                        onChange={setHours}
                      />
                    </Box>
                    <Button submit loading={submitting}>
                      期限を延長
                    </Button>
                  </InlineStack>
                </Form>

                <Divider />

                <InlineStack gap="300">
                  <Form method="post">
                    <input type="hidden" name="intent" value="release" />
                    <Button submit variant="primary" loading={submitting}>
                      引取り（在庫を戻す）
                    </Button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="renotify" />
                    <Button submit loading={submitting}>
                      再通知
                    </Button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="cancel" />
                    <Button submit tone="critical" loading={submitting}>
                      キャンセル
                    </Button>
                  </Form>
                </InlineStack>
                <Text as="p" tone="subdued">
                  「引取り」は来店受取・店頭決済の直前に押してください（reserved→available
                  に戻し、POS で Draft Order を決済）。
                </Text>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
