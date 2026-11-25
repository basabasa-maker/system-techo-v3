# iPhone「システム手帳 ヘルスケア同期」試作

`system-techo-health.shortcut` はキー未設定の署名済みテンプレートです。送信本文修正版で本人がiPhoneから実行し、手帳へ空の結果が届くことまで確認しました。ヘルスケアに値があるのに0項目となる原因として、4項目共通の日付整形が空文字になる不具合をmacOSの固定日付テストで再現しました。今回の日付修正とSafari起動の撤去は本人の「許可する」で公開承認を受けた版20261125-153907です。**iPhoneの実4値取得・単位・合計一致は、修正版での確認が必要です。**

## 初回の設定

1. 普段使うホーム画面の手帳の習慣タブでヘルスケア連携設定を開き、連携キーを発行・コピーします。
2. [追加用ZIP](system-techo-health.zip)をダウンロードし、iPhoneの「ファイル」→「ダウンロード」でZIPをタップして展開します。中の `system-techo-health.shortcut` を開き、「ショートカットを設定」を押します。ファイルへ `.html` が付く誤保存を避けるため、配布入口はZIPにします。
3. 追加時の質問に、手帳でコピーした43文字の連携キーを貼り付けます。質問が表示されない場合は、ショートカットの編集画面で冒頭のテキスト `PASTE_HEALTH_PAIR_KEY_HERE` を置き換えてください。
4. 登録名はファイル名由来の **`system-techo-health`** になることを本人のiPhoneで確認しています。手帳側の「ショートカット名」を実際の登録名に合わせます。現在の呼び出し名を確認し、修正版への差し替えが完了したら使わない旧版は削除して一本化します。名前へ4、5と番号を増やし続ける運用にしません。既存の連携キーは作り直しません。
5. 手帳で確認したい日を表示し、更新ボタンから実行します。ショートカット単体の手動実行には、対象日とリクエスト情報がないため対応しません。
6. 初回のヘルスケア読み取り許可は、体重から4項目が順に表示されます。体重・体脂肪率・アクティブエネルギー・歩数を許可します。このショートカットはヘルスケアへの書き込みをしません。
7. 修正版はSafariを開くアクションを含みません。送信後は画面左上の「システム手帳」から元のホーム画面アプリへ戻ります。表示がない場合はホーム画面から手帳を開きます。完全な自動復帰は実装・検証していません。
8. 初めて届いた項目は、手帳側の確認画面で**同じ日付のヘルスケア表示と値・単位を照合してから**取り込みます。未表示項目を0で補う必要はありません。

連携キーを設定したあとのショートカットは他人に共有しないでください。公開するのは、キーが入っていないこのテンプレートだけです。

## 読み取る内容

| 手帳の項目 | 取得方法 | 送信単位 |
|---|---|---|
| 体重 | 対象日内の最新測定 | kg |
| 体脂肪率 | 対象日内の最新測定 | %（表示値。20%は20） |
| 消費カロリー | 対象日の **アクティブエネルギーのみ**。安静時エネルギーは含まない | kcal |
| 歩数 | 対象日の集計値 | count |

- データがない項目は送信辞書から省略します。前日値を繰り越さず、欠測を0で埋めません。実測0がある場合は0を扱います。
- 日付範囲を対象日の開始〜翌日開始に絞ったうえで、各結果のStart Dateを再び `yyyy-MM-dd` にして対象日と照合します。翌日0時の結果は除外します。
- 歩数・アクティブエネルギーにはFind Health Samplesの **Group by Day / Fill Missing Off** を使います。iPhoneとWatchの生サンプルを単純合算しません。対象日の集計結果が複数に分かれた場合は、その項目を送らない構成です。
- 体重・体脂肪率には日次平均ではなく、対象日内の最新サンプルを使います。
- 送信前に各結果のUnitが `kg` / `%` / `kcal` / `count` と一致することを確認し、不明な単位の項目は送信しません。

## 実機で必ず照合する点

1. **体脂肪率**：HealthKitの内部比率とShortcutsの表示値は同じ扱いにできません。例えばヘルスケアが20%のとき、確認画面が20%になることを確認してください。0.20%や2000%なら取り込まず、ショートカットのUnitとValueの出力を調べます。値の大きさから勝手に100倍する実装にはしていません。
2. **歩数・アクティブエネルギー**：ShortcutsのGroup by Dayが、ヘルスケア画面と同じソース優先順位・重複排除を使うという保証は確認できていません。同日のヘルスケア表示と照合してください。差がある場合、確認前に取り込まず、データソースや集計設定を確認します。
3. **日付**：iPhoneのタイムゾーンで、指定した日だけが対象になることを確認します。午前0時の測定、月末・年末も確認対象です。
4. **戻り方**：元のPWAへ戻るかSafariが開くかは実機次第です。Safariに戻っただけで元PWAの記録が変わらない場合は、元の手帳へ戻ります。

## 保存と通信

- 通信先はファイル生成時に固定した、システム手帳のGAS Web Appです。呼び出し元から渡されたURLへ送信する仕組みはありません。
- 送信先は一時保管の `health_bridge_upload` です。ショートカットから `habit_day_upsert` は呼びません。手帳側で対象日・本人の連携キー・取得後の編集を照合してから、取得できた項目だけを保存します。
- `request_id`・対象日・`issued_at` は手帳から受け取ります。連携キーはショートカット内に設定したものをHTTP本文へ送ります。
- 戻りURLを開く処理自体を撤去し、健康データ・連携キー・リクエストIDをURLで戻しません。旧版からの `#health-return` は手帳側の互換案内として残ります。

## 再生成と構造確認

開発者向け：

```sh
python3 build/build-health-shortcut.py
plutil -lint shortcuts/health-bridge/system-techo-health.source.plist
shortcuts sign --mode anyone \
  --input shortcuts/health-bridge/system-techo-health.unsigned.shortcut \
  --output shortcuts/health-bridge/system-techo-health.shortcut
python3 build/package-health-shortcut.py
python3 tests/health-shortcut.test.py
```

生成スクリプトは標準ライブラリだけを使い、健康データや個人のショートカット一覧を読みません。署名するのはキー未設定のテンプレートだけです。`structure-check.json` は参照UUID・制御ブロック・4つのHealth query・固定送信先・欠測補完OFF・Health/習慣への直接書き込みなしを検査した結果です。Set Dictionary Valueの `WFDictionaryValue` は、単一変数でも `WFTextTokenString`（U+FFFC 1文字と `{0, 1}` の変数参照）で渡します。ここへ単独の `WFTextTokenAttachment` を渡す旧形式は、macOS Shortcutsでも同じ「request_idの値未指定」で停止しました。辞書本体の入力 `WFDictionary` は従来どおり `WFTextTokenAttachment` です。修正版の合成実行では、文字列・数値時刻・小数・0・入れ子辞書・空辞書が最終JSONでも保持されることを確認しました。実Health/ネットワークを使わないmacOSテストであり、iPhoneの実測値照合とは区別します。

`system-techo-health.source.plist` と `.unsigned.shortcut` は編集・再生成用の資料です。配布ZIPは、署名済みの `system-techo-health.shortcut` 一つだけを含みます。ZIP展開後のファイルと元の署名ファイルが完全一致することをpackagerで検査します。

## 構造の根拠

- AppleのローカルActionKit定数・ローカライズにはGroup by / Day / Unit / Fill Missingの存在を確認しました。ただし、非AppleプロセスからActionKitの完全な実行時メタデータを読むとOS側の制限で停止するため、iOSでの動作検証の代用にはしていません。
- Health型フィルタ・プロパティ・パラメータ名は、開発者が匿名化したiOS書き出しとToolKitデータから公開した一次観測資料を使っています。Appleが公開する安定したファイル生成APIではありません。
- 根拠URLと採用時のリポジトリコミット、残る確認項目は `evidence.json` に記録しています。

Appleの公式説明：

- [URLからショートカットを実行](https://support.apple.com/guide/shortcuts/apd624386f42/ios)
- [辞書の利用](https://support.apple.com/guide/shortcuts/apd43b69f337/ios)
- [Macでのショートカット共有と署名](https://support.apple.com/guide/shortcuts-mac/apd455c82f02/mac)

## 送信本文修正版（2026-11-25公開）

File本文の変数指定は `WFRequestVariable = WFTextTokenAttachment` とする。旧 `WFTextTokenString` はmacOSの本文選択で未指定になった。ネイティブUIで合成Payloadを指定したlocalhost送信と書き出し形式を照合済み。生成修正版の本文変数認識は確認したが、そのlocalhost再実行は完了せず中止した。iPhoneでの実測値送信は別途確認が必要。連携キーは同じものを使い、追加済みShortcutは最新版ZIPから差し替える。Web公開版は20261125-122202。

## 日付比較・復帰後受信の修正（2026-11-25、公開承認済み）

Format DateはCustomスタイルに対しWFDateFormat自体をyyyy-MM-ddとする。旧WFDateFormat=Custom/WFDateFormatString=yyyy-MM-ddは、合成nativeの11月24日・25日をどちらも空文字にし、全4項目の日付ゲートで除外していた。修正後は両日とも正しい日付文字列を得た。既存の対象日範囲、単位照合、欠測省略、アクティブのみの指定は維持する。実PhoneのHealthサンプル出力はまだ未確認。

手帳側は一時受信失敗で待機nonceを消さず、復帰や同日の更新で同じ結果を再受信する。期限切れ・中止・別キー・別日・編集中の保護は維持。受信0件の表示を「この日のデータはない」と断定せず、「取得できなかった」とする。
