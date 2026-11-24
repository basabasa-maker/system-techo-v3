# 構造整理の検証記録（機能追加前の履歴）

この記録は目標機能追加前の構造整理を対象とする。当時のファイル一致・未変更の記述を、後の機能追加へ適用しない。現在の追加内容は [goals-feature.md](goals-feature.md) を参照。

実施日：2026-11-24。起点：`3024521ae6928c519be4688c9b355e64da9f9282`。
対象：共有の `/Users/basabasa/basabasa-hq/apps/system-techo-v3`。

## 変更

- `tabs.js` にタブの描画・更新・初回同期の入口をまとめた。
- メモから `memo/body.js` と `memo/attachments.js` を抽出した。
- 同期から副作用のない規則を `sync-operations.js` に抽出した。既存の `sync.mergePatch` 呼出しは維持した。
- 既存データ保持と添付処理の回帰試験、本文・部分更新の契約試験、構成資料を追加した。

## 確認結果

| 確認 | 結果 |
|---|---|
| 整理前の従来ブラウザ試験9件 | 全件成功 |
| 整理前の追加データ保持試験3件 | 全件成功。メモ試験は非同期完了待ちを修正したうえで個別再実行 |
| 整理後の従来9件＋データ保持3件 | 12件を一括実行して全件成功 |
| 整理後の画像添付・転送・キャッシュ試験 | 個別実行して成功。上記と合わせてブラウザ13項目 |
| Node 契約試験 | 8件成功 |
| JS 構文・相対 import・差分書式 | 成功 |
| メモ本文変換・添付I/Oの関数本体 | 整理前のコードと一致（export と配置のみ変更） |
| 390×844の同じ習慣入力画面 | 整理前後のPNGがSHA-256まで一致 |

比較画像の SHA-256：`59be6816ce5d071f28bdf828b435a89500cea66d580ea30bbfec2bae635b5cc9`。

ブラウザ試験は既存の Playwright と Chrome を使用し、localhost と独立した一時 context で実施。GAS の通信はすべて合成応答か遮断。Service Worker は無効にしている。試験のブラウザと一時HTTPサーバーは各実行の終了時に閉じた。

初回の追加メモ試験は、試験側が自動保存の完了前にデータを読んで失敗した。IndexedDB の完了を Node 側から待つように修正し、本体を変更する前に成功を確認した。

## データに関する確認

次の11ファイルは、Git HEADの内容とバイト単位で一致する。

`js/config.js`、`js/store.js`、`js/outbox.js`、`js/gas-client.js`、`gas/Code.gs`、`gas/appsscript.json`、`gas/.clasp.json`、`index.html`、`sw.js`、`manifest.json`、`css/style.css`。

保存先・API形式・localStorageキー・キャッシュスキーマ4・IndexedDB名と版・添付キャッシュ名は変更していない。本番API・本番シート・通常ブラウザの保存領域には接続していない。

合成データで、既存キャッシュの生文字列、outboxのID・時刻・payload・未知操作、旧payloadとの混在、0・削除・復活、メモの未知フィールド・取込日時・添付参照の保持を確認した。添付のPNG→JPEG縮小、base64転送、再取得後の端末保存、次の再読み込みでのキャッシュ利用も確認した。

## 確認範囲

iPhone 実機のホーム画面PWA、ネイティブキーボード、本番GASへの反映、Service Workerによる新モジュールの配信は今回の試験対象外。入力制御・CSS・バックエンドは今回変更していない。コミット・push・デプロイは行っていない。

再実行方法は [tests/README.md](../tests/README.md)、設計の前提と今後の候補は [architecture.md](architecture.md) を参照。
