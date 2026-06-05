import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { data } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  Banner,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Checkbox,
  TextField,
  Divider,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getShopConfig,
  listAllLocations,
  setEnabledLocations,
  setHoldHours,
} from "../lib/pickup/locations.server";
import { runExpireSweep } from "../lib/pickup/sweep.server";
import { UserError } from "../lib/pickup/errors";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const [config, locations] = await Promise.all([
    getShopConfig(admin),
    listAllLocations(admin),
  ]);

  // enabledLocationIds === null は「未設定 = 全店対象」。UI では全 ON で初期表示する。
  const enabledSet = config.enabledLocationIds
    ? new Set(config.enabledLocationIds)
    : null;

  return {
    holdHours: config.holdHours,
    // 未設定(null)のときは全店 ON。設定済みのときはその集合に含まれる店舗のみ ON。
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      isActive: l.isActive,
      enabled: enabledSet ? enabledSet.has(l.id) : true,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "save") {
      const checked = form.getAll("loc").map(String);
      const hoursRaw = String(form.get("holdHours") ?? "");
      const hours = Number.parseInt(hoursRaw, 10);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) {
        return data(
          { ok: false, message: "取置き時間は 1〜720 時間で指定してください。" },
          { status: 400 },
        );
      }

      await setEnabledLocations(admin, checked);
      await setHoldHours(admin, hours);

      const msg =
        checked.length === 0
          ? "設定を保存しました。対象店舗が 0 件のため、取置きは無効化されています。"
          : `設定を保存しました（対象店舗 ${checked.length} 件 / 取置き ${hours} 時間）。`;
      return data({ ok: true, message: msg });
    }

    if (intent === "sweep") {
      const { swept, releasedQuantity, passes, failed } =
        await runExpireSweep(admin);
      const tail =
        failed.length > 0 ? `（失敗 ${failed.length} 件）` : "";
      return data({
        ok: true,
        message: `期限切れ処理を実行しました: ${swept} 件回収 / 在庫 ${releasedQuantity} 点を戻しました（${passes} パス）${tail}`,
      });
    }

    return data({ ok: false, message: "不明な操作です。" }, { status: 400 });
  } catch (e) {
    if (e instanceof UserError) {
      console.error(
        "[app.settings] userErrors:",
        e.userErrors.map((u) => u.code ?? u.message).join(","),
      );
      return data({ ok: false, message: "保存に失敗しました。" }, { status: 422 });
    }
    console.error(
      "[app.settings] error:",
      e instanceof Error ? e.message : "unknown",
    );
    return data({ ok: false, message: "予期しないエラーが発生しました。" }, { status: 500 });
  }
};

export default function Settings() {
  const { holdHours, locations } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const intentBusy = String(nav.formData?.get("intent") ?? "");

  const [checked, setChecked] = useState<Record<string, boolean>>(
    Object.fromEntries(locations.map((l) => [l.id, l.enabled])),
  );
  const [hours, setHours] = useState(String(holdHours));

  const checkedIds = locations.map((l) => l.id).filter((id) => checked[id]);
  const noneEnabled = checkedIds.length === 0;

  return (
    <Page>
      <TitleBar title="設定" />
      <BlockStack gap="400">
        {actionData?.message ? (
          <Banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </Banner>
        ) : null}

        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          {checkedIds.map((id) => (
            <input key={id} type="hidden" name="loc" value={id} />
          ))}
          <input type="hidden" name="holdHours" value={hours} />

          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  取置き対象の店舗
                </Text>
                <Text as="p" tone="subdued">
                  チェックした店舗のみ、EC の取置きフォームに表示されます。すべて
                  OFF にすると取置きは無効になります。
                </Text>
              </BlockStack>

              <BlockStack gap="200">
                {locations.map((l) => (
                  <Checkbox
                    key={l.id}
                    label={l.isActive ? l.name : `${l.name}（非アクティブ）`}
                    checked={!!checked[l.id]}
                    disabled={!l.isActive}
                    onChange={(v) =>
                      setChecked((prev) => ({ ...prev, [l.id]: v }))
                    }
                  />
                ))}
              </BlockStack>

              {noneEnabled ? (
                <Banner tone="warning">
                  対象店舗が 0 件です。この状態で保存すると取置きは無効化されます。
                </Banner>
              ) : null}

              <Divider />

              <Box maxWidth="16rem">
                <TextField
                  label="デフォルト取置き時間（時間）"
                  type="number"
                  value={hours}
                  onChange={setHours}
                  min={1}
                  max={720}
                  autoComplete="off"
                  helpText="申込からこの時間が過ぎると期限切れとして在庫を戻します。"
                />
              </Box>

              <InlineStack>
                <Button
                  submit
                  variant="primary"
                  loading={intentBusy === "save"}
                >
                  設定を保存
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Form>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              期限切れの処理
            </Text>
            <Text as="p" tone="subdued">
              期限を過ぎた「取置き中」の予約をまとめて回収し、reserved
              の在庫を available に戻します。通常は Shopify Flow
              のスケジュール実行で自動化しますが、ここから手動でも実行できます。
            </Text>
            <Form method="post">
              <input type="hidden" name="intent" value="sweep" />
              <InlineStack>
                <Button submit loading={intentBusy === "sweep"}>
                  期限切れを今すぐ処理
                </Button>
              </InlineStack>
            </Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
