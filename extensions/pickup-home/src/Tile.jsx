import "@shopify/ui-extensions/preact";
import { render } from "preact";

export default async () => {
  render(<Tile />, document.body);
};

/**
 * POS ホーム（スマートグリッド）のタイル。
 * タップで pos.home.modal.render（Modal.jsx）をフルスクリーン表示する。
 *
 * 用途: 店舗スタッフが「取置き引取り」を 1 タップで開けるよう、
 * ホーム画面に常設のエントリポイントを置く。
 */
function Tile() {
  return (
    <s-tile
      heading="取置き引取り"
      subheading="引取り待ちの取置きを確認・引渡し"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
