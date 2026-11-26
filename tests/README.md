# 入力・タブ切替の回帰試験（2026-11-13）

`races.cjs` は独立した一時ブラウザプロファイルと localhost のみを使用します。
GAS リクエストは Playwright の route で合成応答へ置き換え、他の外部通信は遮断します。
普段のブラウザのログインや本番のスプレッドシートには触りません。

## 実行

既存の Playwright を使い、インストール先と Chrome のパスを環境変数で指定できます。

```sh
PLAYWRIGHT_PATH=/path/to/node_modules/playwright \
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node tests/races.cjs
```

`APP_ROOT` を指定すると、修正前の独立コピーでも同じ試験を実施できます。
`SCREENSHOT` にファイルパスを指定すると、入力保持試験の画面を保存します。

## 確認範囲

- 遅い習慣同期のあとでも、食事・タスク・デイリー・メモの表示先を変えない
- 入力中の数値とフォーカスを維持する
- 累計を短時間で入力しても、遅延タイマーや再タップで消さない
- 保存済みの値を、保存前に始めた取得の遅い応答で戻さない
- 食事の時刻入力中に前のタブの応答が返っても入力を維持する
- オフライン時の習慣・食事の即時キュー保存と復帰後の再送、変更部分のみの保存
- 高速タブ切替、戻り、手動更新の応答後も現在のタブ・入力を維持する
- 累計の連続入力・0・負数
- 失敗したキューをまとめても、新しい編集より後ろに並べ直さない

## 検証履歴

修正前 HEAD `6211019` のコピーでは最初の6試験すべて失敗し、元の症状を再現。
修正版では上記9試験すべて成功。全 js の `node --check` と `git diff --check` も成功。
390×844 のモバイル寸法で画面を取得して確認。
これは Mac の隔離 Chrome での試験です。iPhone 実機のホーム画面 PWA・iOS のネイティブキーボードの表示までは未確認。
初回検証時は公開前承認待ち。2026-11-13 に本人から公開承認を受け、ビルド版 `20261113-112828` で全9試験を再実行し成功。GAS・本番データの変更はありません。

## 修正の要点

- 画面の表示先をタブを開くたびに分離し、古い画面・古い取得の完了から現在の DOM を作り直さない。
- 習慣・食事の取得中に入力していたら state と DOM を維持する。
- 累計の欄は focus 時に一度だけ空にし、遅延リセットと pointerup ごとのリセットを廃止する。
- 習慣・食事は変更直後に outbox に記録し、共通 flushAll から送信する。食事は送信のみ800msまとめる。
- 取得開始時の編集版を照合し、後から保存完了した値にも古い取得を適用しない。
- 失敗キューの統合時は ID を維持し、新しい入力より後へ古い入力を並べ直さない。
- デイリーの取得日を開始時に固定。メモの手動更新と習慣グラフにも表示先・取得順ガードを追加。

公開が承認された場合は、`build/cache-bust.sh` で HTML/SW の版を更新してから検査・コミット・push を行い、公開されたファイルと期待版を照合してください。

## 構造整理後の互換性試験（2026-11-24）

Node.js 24 で、通信・ブラウザ・追加依存なしの契約試験8件を実行できます。

```sh
node --test tests/contracts.test.mjs
```

本文と添付トークンの往復、旧形式を含む習慣・食事の部分更新、削除と復活、0、操作の非破壊的な統合、相対 import の参照先、既存 `sync.mergePatch` の互換性を確認します。

`races.cjs` には、次の4件も追加しています（既存9件と合わせて13件）。データ保持3件は本体の整理前後に実行し、添付の転送・キャッシュは整理後にも確認します。

- schema 4 の既存 localStorage の生文字列と IndexedDB outbox の ID・保存時刻・payload・未知操作を、オフライン再読み込み後に照合。
- 旧習慣 `values` / 旧食事 `slots` と現行 PATCH を混ぜても、順序・部分更新・削除・復活・0・無関係な値を維持。
- メモ本文のPDF添付・未知記法・取込日時・ピン・手動順・未知メタデータを、700ms自動保存失敗と取得失敗後にも維持。

- PNGからJPEGへの縮小・転送・本文トークン保存、再取得した添付の端末保存とオフライン再読み込み。

全試験は独立した一時 browser context を使い、終了時に閉じます。外部通信は route で合成または遮断し、Service Worker を無効化します。本番のシート・通常ブラウザ・iPhone 実機を使った試験ではありません。

## 目標・ビジョンボード（2026-11-24）

```sh
node --test tests/contracts.test.mjs tests/goals-data.test.mjs
node tests/gas-goals.cjs
PLAYWRIGHT_PATH=/path/to/playwright node tests/goals.cjs
```

`goals.cjs` は独立一覧、共通＋メニュー、目的/目標/複数手段の入力、画像共有/表紙/説明/回転、オフライン保持、遅い応答、横タブ並替、写真移動とキャンセル、添付失敗からの再試行、表紙OFF、アップロード中の編集保持、7枚以上の配置を検証する16件。`GOALS_TEST=regression` で追加3件だけ実行可能。`GOALS_SCREENSHOT_DIR=/tmp/goals-screens` で画面を保存できる。

25件のNode契約試験と12群のGAS/client隔離試験も用意した。GASの試験はスプレッドシートをメモリ内で再現し、実際の同期→client→GAS handlerの依存順も確認する。本番Googleサービスは呼ばない。公開条件・既知の範囲は [目標機能の資料](../docs/goals-feature.md)、画面確認は [design-qa.md](../design-qa.md)。

写真操作は短タップのメニュー、450ms長押し移動、長押し前のパン、pointercancel/Escape/pinchの復元、削除取消と論理削除を確認する。今回の変更では影響10項目を成功確認済み。

## 公開候補の最終確認（2026-11-24）

公開候補版 `20261124-233508`。Node契約25件、GAS/client12群、既存ブラウザ13件、新機能ブラウザ16件がすべて成功。全27 JSファイルとGASの構文、`git diff --check` も成功。切り替え項目の固定は390×844のHTTPS試作画面でスクロール前後の座標を照合し、切り替え行が主タブ直下に留まり本文だけが動くことを確認した。実機iPhoneと本番配信は未確認。

## 前日の最終食事の自動反映（2026-11-24）

`node --test tests/meal-time.test.mjs` は時刻の大小、0時、正規化、不正値、元記録の非破壊を確認する3件。`PLAYWRIGHT_PATH=/path/to/playwright node tests/last-meal.cjs` は習慣の手動更新だけの反映・年跨ぎ・1項目PATCH・欠測/失敗・手入力・日付/タブ切替・未送信・取得後編集・削除済み項目を確認する14件。すべて合成API・独立ブラウザで、本番へ接続しない。詳しくは [仕様と保持条件](../docs/meal-last-time.md)。

2026-11-25の修正では `last-meal.cjs` に保持フォーカスの再現を追加し、全15件が成功。ボタン押下で入力のfocusが残っても選択日の当該欄だけへ反映し、他日と食事データが不変であることを確認する。内容が空でも時刻がある食事は対象、時刻未入力は無操作。

## iPhoneヘルスケア連携・習慣上部固定（2026-11-25）

```sh
node --test tests/contracts.test.mjs tests/goals-data.test.mjs tests/meal-time.test.mjs tests/health-model.test.mjs tests/health-bridge.test.mjs
node tests/gas-health.cjs
PLAYWRIGHT_PATH=/path/to/playwright node tests/health.cjs
```

Node44件、GAS Health11群（Sheet/Properties呼出ゼロ）、新Healthブラウザ15件。初回設定中のdraftキー保持と、保存直前の期限再確認も失敗再現→修正→成功を確認した。HealthのOS起動境界はNavigation APIで止め、すべて合成受信結果で対象日のPATCHと他日不変を確認する。実機Healthや個人Shortcutを試験で実行しない。初回確認・取消、欠測・0、単位/対象日/期限、手入力を元に戻す場合、日付/タブ切替、未送信、保存開始後の中止不可を検証する。旧入力13・最終食事15・目標16も回帰対象。

Shortcutの生成は `python3 build/build-health-shortcut.py`、署名は[生成手順](../shortcuts/health-bridge/README.md)を参照。plist構造検査と署名成功は実機実行成功を意味しない。公開前承認・実機で残る確認は[仕様](../docs/health-bridge.md)に記録。

## ヘルスケア欄の折りたたみ（2026-11-25）

`tests/health.cjs` は16件。初期閉、Spaceキーでの開閉、通常更新後の開閉状態維持、再読み込み時の初期閉、開閉だけでHealth取得や保存が起きないことを追加確認する。`HEALTH_COLLAPSED_SCREENSHOT` と `HEALTH_EXPANDED_SCREENSHOT` にパスを指定すると390×844の画面を保存する。実Healthと本番記録は使用しない。

## Shortcutの辞書変数とZIP配布（2026-11-25）

`python3 tests/health-shortcut.test.py` の3件で、実書出しに合うsingle-token text形式、4項目の抽出/欠測規則、キー未設定の追加質問とplist往復を確認する。旧Attachment値はこの試験で失敗し、macOSのHealth/通信なし合成Shortcutでも実機と同じrequest_id値未指定を再現。修正後のnative実行は、文字列・数値時刻・小数・0・入れ子辞書・空辞書のJSON出力まで照合済み。iPhoneの実Health読取成功を意味しない。

Health browserはZIPダウンロードを加えて17件。ZIPの名前・内容一致・設定画面が維持されること・保存ボタンがモバイル画面に収まり本文が内部スクロールすることを確認する。`HEALTH_SETUP_SCREENSHOT` で設定画面を保存できる。

## 全体設定と安全なアプリ更新（2026-11-25）

```sh
node --test tests/app-update.test.mjs tests/app-update-safety.test.mjs tests/app-update-worker.test.cjs
PLAYWRIGHT_PATH=/path/to/playwright node tests/app-settings.cjs
PLAYWRIGHT_PATH=/path/to/playwright node tests/app-update-service-worker.cjs
```

更新本体・安全guard・SWを依存注入/メモリ内キャッシュで確認する。版/相対URL/SHA/index版/active worker版が一致したときだけ同じ画面を再読み込みし、入力・保存・添付・Health待機・未送信・取得失敗・不完全配信では停止する。workerは新静的キャッシュの完成前に旧キャッシュを変更せず、添付/他用途のキャッシュも消さない。

設定ブラウザ14件は、本番APIとHealthを遮断した合成APIだけで設定UI・空欄・説明ページ・更新/停止・メモの入力保持を確認する。`SETTINGS_SCREENSHOT`、`SETTINGS_LIGHT_SCREENSHOT`、`HEADER_SCREENSHOT`で390×844の画面を保存する。実SW統合試験は同じ隔離ブラウザのlocalhost配信を版A/Bへ切り替えて確認し、普段のPWAや本番へは接続しない。


実SW試験の`UPDATE_SW_LEGACY=1`モードは、初回移行の確認用に`git show d186547:sw.js`を読み取り、旧network-first workerから新workerへ切り替える追加1ケースだけを実行する。そのためGit履歴の該当commitが必要。通常モードはA→B更新・Bのオフライン起動・壊れたCの拒否・B維持の4ケース。どちらも記録・連携キー・未送信・添付の保持を合成データで照合し、実Health/本番記録を使わない。

## Shortcut名に空白がある場合（2026-11-25）

Health bridgeのNode9件とmodel8件。名前のqueryを生のpercent decodingで照合し、空白が`+`へ化ける修正前の失敗を確認する。Healthブラウザは18件で、`system-techo-health 2`という複製名の起動と設定/キー不変、対象日だけの保存を追加した。URLSearchParams.getは`+`を空白へ戻すので、それだけでネイティブ起動名の正しさを判断しない。


## メモ本文面の再構成（2026-11-26）

```sh
node --test tests/*.test.mjs tests/app-update-worker.test.cjs
PLAYWRIGHT_PATH=/path/to/playwright MEMO_ENGINE=chromium node tests/memo-editor.cjs
PLAYWRIGHT_PATH=/path/to/playwright PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers MEMO_ENGINE=webkit node tests/memo-editor.cjs
PLAYWRIGHT_PATH=/path/to/playwright node tests/races.cjs
PLAYWRIGHT_PATH=/path/to/playwright node tests/app-settings.cjs
PLAYWRIGHT_PATH=/path/to/playwright node tests/app-update-service-worker.cjs
```

`MEMO_ARTIFACT_DIR` でメモ試験のJSON/画面保存先、`MEMO_TEST` でケース名の部分一致を指定できる。WebKitはPlaywright用WebKitのインストールが必要。通常のブラウザや本番サービスは使用しない。

公開候補 `20261126-104155`。Node全122件（本文11・復旧13を含む）、メモ20ケースをChrome/WebKit両方、設定16件、目標16件、実SW4件が成功。メモ20件は19件の一括実行と追加削除失敗1件の個別実行を両ブラウザで行い、CSSタイル変更後は影響する長文ケースを再実行した。GAS/client隔離試験も目標12群・Health11群、既存Shortcut構造7件が成功。既存入力13件も全件成功。ブラウザ試験はメモ40＋設定16＋既存13＝69件が成功し、さらに目標16・実SW4件も確認した。

新しい本文面で、チェック/Undo/改行、罫線ON/OFF、長い日本語/絵文字/折返し、単なる開閉でCRLF・空白・末尾改行・添付・メタデータが不変なこと、入力途中/保存拒否での離脱保護、遅い保存/取得/添付、同じメモを開き直した後の添付、削除後の古いGET非復活、オフライン再送を確認する。IndexedDBへのenqueueだけを失敗させ、再読込後も新本文を保持・削除を復活させず、同じ画面での再試行後も送信待ちが解除されることを確認する。

取り消し線の実文字の座標は32pxスクロールに対し−32px動く。下部の可視16行の罫線をON/OFF画像の画素で比較し、全行で差があることも確認する。DOMのline-height/gradient属性だけで描画成功と判断しない。長い背景のrepeating gradientはWebKitのテスト環境で折返し部分に描画されないため、通常のlinear-gradientを32pxタイルとして繰り返す。

iOS 27のiPhone 17 Simulator Safariでもlocalhost合成本文で録画・フレーム計測を行う。実iPhoneの日本語IME、指フリック慣性、ホーム画面PWAは未確認。保存形式・公開判断・検証の範囲は [memo-editor.md](../docs/memo-editor.md) を参照。

2026-11-26に公開承認を受け、配信用版 `20261126-134727` を生成。候補版から本文ロジック・CSS・vendorの変更はなく、承認後もNode122件、構文・配信55ファイルのSHAを再確認した。


## メモの初回フォーカス（2026-11-26）

```sh
PLAYWRIGHT_PATH=/path/to/playwright MEMO_ENGINE=chromium node tests/memo-focus.cjs
PLAYWRIGHT_PATH=/path/to/playwright PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers MEMO_ENGINE=webkit node tests/memo-focus.cjs
```

27ケース×2。`MEMO_FOCUS_TEST`でケース名を絞り、`MEMO_ARTIFACT_DIR`で結果保存先を指定する。初回tapの制御・native focusへのpreventScroll引数・focus前の選択位置・追記/Undo・IMEとgesture例外・実観測した70px panの座標再生を確認する。WebKitのUAはSafari27を明示し、CodeMirrorのSafari>=26のfocus fallbackも対象にする。headlessでOS keyboard pan自体は再現できなかったので、別の公式XCUITest実キーボード確認と混同しない。

本文/保存のNode32件、既存メモ20件の回帰も確認。実native試験では空・短文・長文・チェック追加の4ケースと日本語入力/保存を確認し、全rAFで画面・本文上端が固定された。実行範囲と証拠は [memo-focus.md](../docs/memo-focus.md) を参照。

本人の承認後、配信用版 `20261126-154700` を生成。native検証済みのメモ2モジュール・CSSおよびfocus QA対象ソースのSHAが一致し、Node全122件と配信55ファイルのSHAが一致することを再確認した。
