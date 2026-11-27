# iPhoneヘルスケア連携ショートカット 1.0.1

> **未解決：iPhoneでは「そんなファイルない」と呼出エラーが報告されている。iPhoneミラーリングがTouch ID認証で止まっており、iPhone内の実名・手帳が呼ぶ名前・実際に応答する版は未照合。Macの既存名 `system-techo-health 4` は保持しているが、これをiPhoneでも正常に呼べる証拠とは扱わない。推測で再追加・改名して解決済みにしない。**

明示管理する配布対象は `1.0.1`、通信規約は数値 `1`、歩数の取得元表示は `apple_watch`。public templateの名前と配布ファイル名は `system-techo-health` に固定する。末尾の4、5等を増やす方法で版を管理しない。個人用の既存名と公開template名は別に扱う。

`1.0.0` は数値型の不備で**公開前に撤回した候補**。配布・公開しない。1.0.1の静的Payload辞書はApple UIで作成・書出しした形式と一致し、生成R3のキーなし5アクションをApple実行器のGUIで実行して `shortcutVersion: "1.0.1"`、JSON numberの `protocolVersion: 1`、`stepsSource: "apple_watch"` を確認した。これはiPhoneでの本来の呼出・実Health読取・保存成功の確認とは区別する。今回の公開対象ビルドは `20261128-003214`、通常APIはGAS public版 `28` へ反映済み。本人限定バックアップ管理のprivate版 `26` も維持されていることをread-onlyで照合済み。

現行の詳細と過去の検証経緯は[連携資料](../../docs/health-bridge.md)を参照。11/25の4項目取込成功は当時の確認であり、今回のiPhone呼出エラーの解消根拠にはしない。

## 名前と版を確認する

設定のヘルスケア欄では次を分けて表示する。

| 表示 | 意味 |
| --- | --- |
| この端末が呼ぶ名前 | この端末に保存された起動先の名前。iPhone内の実在確認を代行する表示ではない |
| 配布ショートカット版 | アプリが案内するtemplateの版 `1.0.1` |
| 最後に応答した版 | この端末が有効な応答から受け取った版と通信規約 |
| 応答を確認した時刻 | 手帳が応答を取得・検証した時刻。測定時刻や記録保存の成功時刻ではない |

応答が未確認なら「未確認」。版情報のない旧形式は `unknown` と扱い、画面には「版情報なし（旧形式）」と表示する。名前の数字から版を推測しない。配布版と応答版が一致しても、個々の測定値や保存の成功までは保証しない。公開更新だけで端末に追加済みのShortcutが自動で最新版になるとは扱わない。

## 初回の設定・差し替え

1. ホーム画面の手帳で「設定」→「ヘルスケア連携を設定」を開き、連携キーをコピーする。既存連携の差し替えではキーを再発行しない。
2. [1.0.1追加用ZIP](releases/1.0.1/system-techo-health.zip?_app_update=health-shortcut)を取得する。iPhoneの「ファイル」→「ダウンロード」でZIPを展開し、中の `system-techo-health.shortcut` を開く。追加時の質問へ43文字のキーを貼り付ける。質問が出なければ冒頭の `PASTE_HEALTH_PAIR_KEY_HERE` を置き換える。
3. iPhone内の実際の登録名を確認して、手帳の「ショートカット名」と照合する。Macの実名をiPhoneの実名と推測しない。上記の呼出エラーはこの照合が未完了である。
4. 対象日を表示して手帳の更新から実行する。単体の手動実行は対象日・リクエスト情報がないため対応しない。初回は体重・体脂肪率・アクティブエネルギー・歩数の読み取りを順に許可する。Healthへの書き込みはしない。
5. 送信後は左上の「システム手帳」、またはホーム画面から元の手帳へ戻る。Safariを明示的に開く処理は含めず、完全な自動PWA復帰は保証しない。
6. 初回の項目は同日・同じ単位の値を確認してから取り込む。歩数はWatch基準として確認し、Healthの全ソース統合値と常に一致するものとは説明しない。設定の応答版と時刻も照合する。

キー設定済みの個人用Shortcutは共有・公開しない。公開するのはキー未設定のtemplateだけ。使わない旧版を整理する場合も、実名と応答版を確認してから行い、動いている個人用を名前だけで削除しない。

## 読み取る内容

| 手帳の項目 | 取得方法 | 送信単位 |
| --- | --- | --- |
| 体重 | 対象日内の最新測定 | kg |
| 体脂肪率 | 対象日内の最新測定 | %（表示値。20%は20） |
| 消費カロリー | 対象日のアクティブエネルギー。安静時は含まない | kcal |
| 歩数 | 同日・count単位でSource表示にApple Watchを含むrawサンプルの合計 | count |

- 歩数のqueryはGroupByなし。Sourceの `Apple Watch` を大小文字を区別せず検索し、Matchesがあるサンプルだけを加算する。iPhone・他Sourceは加えない。複数Watchの採用分は合算し、物理機器IDによる区別や重複調整は行わない。
- アクティブエネルギーは従来どおり Group by Day / Fill Missing Off。対象日の候補が1件の場合だけ送る。Shortcutsのこの集計とHealth画面の統合方法が同一である保証は確認していない。
- 日付は対象日の開始〜翌日開始で絞り、結果のStart Dateを `yyyy-MM-dd` にして再照合する。各結果のUnitも確認する。タイムゾーンと午前0時の境界は実機で照合する。
- 欠測は送信辞書から省略し、前日値を繰り越さず0で埋めない。Watch欠測もsteps省略とする。実測0は保持する。過去の記録を一括補正しない。
- Web側は体重・体脂肪率・アクティブエネルギーを新規取込時に小数第1位、歩数を整数として扱う。体脂肪率の値を推測で100倍しない。

## 保存と通信

通信先は生成時に固定したGASの一時保管API `health_bridge_upload`。Shortcutから習慣シートへ直接書かない。手帳からの入力は `request_id / date / issued_at` の3項目で、健康値やキーを起動URLへ入れない。連携キーはHTTP本文だけに含める。

初期Payload辞書にTextの `shortcutVersion` とNumberの `protocolVersion` を持たせ、後続の既存辞書更新で測定値等を追加する。`stepsSource: "apple_watch"` も付けて、GAS Cacheのread経由で返す。印のない旧結果の歩数は対応Webで保存せず、他3項目の処理は保持する。版・sourceメタ情報は通信方式の自己申告であり、暗号的な機器認証ではない。

手帳は対象日・期限・キー・手入力・未送信を照合し、取込対象だけをPATCHで保存する。保存なし確認では測定値・最終取込情報・未送信キューを変えない。応答版と応答時刻のメタ情報は確認結果として更新され得る。

## 配布物とハッシュ

中央定義は `build/health-release.json`。builderはここからtemplateと `js/health/release.js` を生成する。配布版は次の変更不可パスへ置く。

```text
releases/1.0.1/
  system-techo-health.shortcut
  system-techo-health.zip
  source.plist
  manifest.json
```

[manifest.json](releases/1.0.1/manifest.json)に公開名・版・通信規約・source・各artifactのSHA-256とbyte数を記録する。

| 1.0.1配布物 | SHA-256 |
| --- | --- |
| 署名済みShortcut | `6b09fa0cc9050762fe7778fbae3d4ec942eccbb8f91dd5d7cee4aa15b590a2f3` |
| ZIP | `b00f7badd289597a15c7686830bcd05bf9e98e74bfd9b67969e4b0c72353cb6e` |
| source.plist | `dc907853caddc86ce7a1136326fd6689956e82a331ed5fd1b0cd806b6e998a05` |
| manifest.json自体 | `5fe2f6153d0793b494ed3f0ed1440e239d5bbef22211014c1a2dc1b0bb90465b` |

Apple公開証明書で署名を検証し、署名container内の全176アクションとImportQuestionsが生成元と一致することを確認した。Apple署名による名前の除去・clientVersion・QuickActionSurfacesの正規化は測定処理の変更と区別した。これは実Health読取やiPhoneでの起動成功を意味しない。

`artifacts["system-techo-health.shortcut"].sha256`、ZIP、sourceのhashを実ファイルと照合する。連携キー・個人の測定値・個人用Shortcutはmanifestへ収録しない。

同versionに異なるhashのファイルがあればpackagerは上書きを拒否する。修正は次のversionへ上げる。従来の [latest互換ZIP](system-techo-health.zip?_app_update=health-shortcut) は維持するが、設定の配布リンクは版別URLを使う。ZIPにはキー未設定の署名済みShortcut一つだけを含める。

## 再生成と検証

```sh
python3 build/build-health-shortcut.py
python3 tests/health-shortcut.test.py
python3 tests/health-release.test.py
plutil -lint shortcuts/health-bridge/system-techo-health.source.plist
```

署名・内容確認後にpackagerを別途実行する。構造試験や署名コマンドのexit0だけで配布へ進まず、静的Numberが最終JSONでも数値1であることをApple実行器で確認する。初版の型不備でこの条件を満たさなかった1.0.0は公開前撤回とした。

Number辞書項目はApple UI実exportと同じ `WFItemType=3`、値は `WFTextTokenString` の `string: "1"`。生成R3の5アクションでJSON number1を確認済み。後続Set Dictionary Valueの動的値は単一変数でも `WFTextTokenString`、辞書本体の入力は `WFTextTokenAttachment`。HTTP File本文の変数は `WFTextTokenAttachment` とする。

構造・合成試験は実HealthやiPhoneの呼出成功の代用にしない。根拠と過去の修正は[連携資料](../../docs/health-bridge.md)と `evidence.json` を参照。
