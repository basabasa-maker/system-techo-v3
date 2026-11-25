# システム手帳 v3

iPhone のホーム画面から使う個人用手帳 PWA。デイリー、タスク、習慣、食事、メモ、目標の6機能を持ちます。
HTML / CSS / ES modules で動き、ビルド処理やフロントエンドフレームワークはありません。

- 共通の現役ソース：`/Users/basabasa/basabasa-hq/apps/system-techo-v3`
- GitHub：`basabasa-maker/system-techo-v3`
- [構成・保存の前提・機能追加の手順](docs/architecture.md)
- [目標とビジョンボードの仕様・検証・公開手順](docs/goals-feature.md)
- [前日の最終食事の自動反映](docs/meal-last-time.md)
- [iPhoneヘルスケア連携の試作と初期設定](docs/health-bridge.md)
- [隔離環境での回帰試験](tests/README.md)
- [iOS ショートカット連携](docs/ios-shortcut-setup.md)

半兵衛と Claude Code はこの同じ作業ツリーを使います。編集前に `git status --short --branch` と差分を確認し、他の担当の編集を上書きしないでください。旧 v1 や仕様フォルダは現役ソースではありません。

ローカルの構造整理と本番公開は別工程です。公開承認を受けるまでは push・GAS 反映・デプロイを行いません。動作確認は本番の GAS に接続せず、[試験手順](tests/README.md)を使います。

- [Web版の設定・安全なアプリ更新とプライバシー説明](docs/app-settings.md)
