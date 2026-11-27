# 歩数の不一致調査（2026-11-27、集計値の原因は未確定）

依頼：iPhone Shortcutで歩数は取得できるが、Healthの日別合計と毎回違う。歩数以外と過去の記録を変えずに調査する。

## 現在の確定事項

- 調査開始HEADは7ccb7a6。未公開の文章・画像・バックアップ候補がある。後続の本人指示で公開準備を進めているが、それらと歩数の不一致修正は別に扱う。
- 公開済みZIPとHealth model/bridge/UIの3モジュールは手元とSHA一致。ZIP内署名済みファイルと元ファイルも一致。
- 配布元plistの歩数は Type=Steps、GroupBy=Day、Unit=count、FillMissing=false、limitなし、Start Dateによる対象日範囲。ソース別の生サンプルをJSやGASで足し合わせてはいない。
- 実GAS upload/read/ack、実receiveHealth、実habit_day_upsertをメモリstubで接続した合成試験では、整数の送信値が同じ値で日別保存される。連続取込は加算せず置換。小数歩数は丸めず拒否。別日・期限切れは反映しない。
- 正常完了時はpendingを破棄する。常に古いnonceを使い続けるわけではない。

## 再現した保護動作（今回の原因とは未確定）

1. 同じnonceの再アップロードは最初の結果を保持する。後から歩いた増分は同じnonceの結果へ足されない。
2. 取得開始時のbaselineと、通常再取得後の値が違う場合は、手入力や別端末での変更を守ってHealth結果をskipする。
3. 同じ日の別項目に未送信操作がある場合も日単位の保護が働き、歩数をskipする場合がある。
4. 歩数項目を累積等へ再定義した場合、Health自動取り込みの対象外になる。

これらを今回の原因と決めつけて保護を外す修正はしていない。

## Apple一次資料

- [Apple DTS 759709](https://developer.apple.com/forums/thread/759709)：生サンプルの単純合算は多重計上になり得る。HKStatisticsQueryは重複排除し、同じ時間範囲のHealth表示と一致することを案内。
- [WWDC20 Getting started with HealthKit](https://developer.apple.com/videos/play/wwdc2020/10664/)：14分台の統計説明で、iPhone/Watch重複を除き、Watchを外した時間のiPhone分は足す挙動を説明。単にWatchだけを選ぶ・ソース別最大を選ぶ方法と同じではない。
- [HKStatistics](https://developer.apple.com/documentation/healthkit/hkstatistics.md)：統計クエリは通常複数ソースをmergeする。
- [Shortcuts Find/Filter](https://support.apple.com/guide/shortcuts/intro-to-find-and-filter-actions-apd3c845e881/ios)：入力がある場合のfilterと、ライブラリから探すFindの違い。

Apple同梱のiOS 27 ActionKitローカライズではGroupBy/Day/Unit/FillMissingの項目名を確認できたが、集計関数や重複排除の仕様は見つからなかった。

ただし、ShortcutsのGroupBy=DayがこのHKStatisticsQueryと同じ設定・ソース統合を使うという証明は未取得。AppleのHealthKit説明だけからShortcutsも正しいと断定しない。

## まだ必要な確認

- 両表示値を受領。手帳側がHealthより大きい。当日の習慣画面ヘッダーも11月27日と本人が確認済みなので、今回を前日画面のままだったことによる不一致と扱わない。最後の更新は朝で、Health表示の比較と完全な同時点ではない。測定値は公開資料・テストへ転載しない。
- 11/26はCUAがMacロックで停止。11/27の本人による解除後、登録済みsystem-techo-health 4の歩数検索を確認した。ロック回避・DB読取り・実Health/送信実行はしていない。
- 日本時間の同じ開始/終了、読み取り時点、集計モード、入力がLibraryか、ソース条件、候補数/採用値を実体で確認する。キーは読取記録へ転記せず、再発行/追加し直しを推測で依頼しない。
- 実際の両数値の比較前に、複数ソース・時差・取得後の増分・古い結果・保護skipのどれかへ断定しない。

歩数の集計ロジック・過去データの修正はまだなし。登録済み実体の検索設定は確認できたため、同じ箇所のスクリーンショットを重ねて依頼しない。次は同時点の新しい検索値とHealth日別合計を照合し、集計・転送・保護skipのどこで違うかを特定する。

## 成果物と再実行

作業成果物は `~/Documents/Codex/2026-11-24/task-6/health-steps-audit/` に保存。以下はその中のファイル名。

- `static-check.json`：公開静的物のSHA照合。
- `health-steps-audit.mjs`：Google/Healthなし、全メモリstubの再現runner。
- `synthetic-steps-test.log`：上記の整数保存・保護動作・拒否の結果。
- 既存のHealth model/bridge Node18件とGAS11群も成功。

runnerは `node health-steps-audit.mjs`。実ネットワークを使わず、公開b03939dのreceiveHealth本体と同じことをGit履歴で検査してから実行する。全て架空データで、本人の測定値は含まない。


## 11/27の本人用検索アクションの実体確認

MacではHealth検索が非対応で詳細非表示のため、本人用system-techo-health 4のSteps検索アクション1個だけをCUAでコピーし、キーなしの一時Shortcutから書き出した。本人用全体をキー付きで書き出す方法は使っていない。Apple aea CLIで公開証明書による署名を検証し、AppleArchiveからShortcut.wflowを展開して確認した。

UUIDを除く検索パラメータが配布版と完全一致：Type=Steps、GroupBy=Day、Unit=count、Input=Library、StartDateがWindowStart〜WindowEnd、FillMissing=false、limit=false。書式・単位の確認と、実際の集計値の一致は別の確認である。

書出しファイルを内容確認後、一時Shortcutだけを整理し、開始時の元の5個が維持されることをCUAで確認した。本人用のキー・処理・記録は変更せず、実際のHealth読取・送信は一度も実行していない。

`installed-query-check.json`、`installed-query/Shortcut.wflow`、署名済みのキーなし検査ファイルは上記作業成果物フォルダに保存。OS同梱メタデータの追加調査でもGroupByDay内部の重複調整方式は判定できず、関連文字列が見つからないことを未使用の証拠とは扱わない。

## 隔離Simulatorの試行と限界

専用iOS Simulatorと合成データ用アプリで、複数ソースの日別集計とHealthKit統計の比較を試みた。通常Xcodeビルドの起動後、Health認可APIが `Missing com.apple.developer.healthkit entitlement.` を返したため停止した。合成保存・Health DB読取り・Shortcuts実行はいずれも0。保護の無効化や実アカウントへの切替は行わず、専用Simulatorだけを削除確認した。この試行は重複計上やGroupByDayの動作を確認した証拠にはならない。

歩数だけのキー不要・保存送信なし診断候補と、Healthを使わない6種類のfixtureを作業成果物 `diagnostic/` に用意した。元の検索・日付境界・採用条件の一致と構造検査11件は成功したが、署名・追加・ネイティブ実行は未実施。本体の読み取り方式や過去の記録は変更していない。

## 更新後に増えるとの追加報告と保存なし確認

本人は「開くだけ」ではなく「更新→Shortcut読取の後に増える」と明言した。同じ合成値を連続取り込み、再起動、保存後の応答喪失と再送を実コードで検証しても加算は再現せず、原因未確定。保存先の歩数項目はintegerであることも読み取り確認した。個人の数値は公開しない。

既存Shortcutの結果を保存せず観測する「設定」→「歩数を確認（保存しない）」を追加。通常の待機情報とは別のキーへ保存し、旧版アプリが観測結果を取り込まないことも旧bridge実体（Git履歴299419f）で検証した。Healthの4項目、確認済み項目、最終取込メタ情報、未送信キューを変えず、受信歩数と手帳の歩数を比較できる。これは診断機能であり、不一致の修正完了ではない。実機では受信歩数と直後の同日Health合計を比較する。

架空データ試験：再openと同値読取2件、保存・再送9件、Healthブラウザ31件、Node149件、設定17件、バックアップ設定8件。観測画面はChrome/WebKit×320/390幅×2テーマで8条件成功。ソースのplain-data検証はApple Shortcuts実行器での証明にはならない。標準Shortcut内の別統計アクションも一次資料と構造化metadataを調べたが、Health日別合計と同一と証明できる代替は未発見。Watchのみ、ソース別最大値、一定量の減算などを根拠なく採用しない。

成果物は作業フォルダ内 `reopen-growth/`。`storage-replay-results.json`、`shortcut-source-results.json`、`observation-ui/observation-ui-results.json` をそれぞれ使用する。初稿で衝突した共通名results.jsonは根拠に使わない。実iPhoneでの同時点照合は未完了。
