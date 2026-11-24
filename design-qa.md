# Goals design QA — 2026-11-24

final result: passed

## Visual truth and evidence

選択画像は `/Users/basabasa/Documents/Codex/2026-11-24/task-6/goals-ui/selected-goal-list.png`（852×1846、意図したCSS寸法390×844）。ユーザーは写真カード＋コルクボードを選択し、その後に独立した目的/目標一覧と共通＋メニューを指定した。

同じtask workspaceの `goals-ui/implementation-goal-cards.png`、`implementation-purposes.png`、`implementation-vision-board.png`、`implementation-add-menu.png`、`implementation-board-caption.png` が実ブラウザの証拠。すべて390×844、deviceScaleFactor1。サンプルAPIと生成写真のみの隔離プレビュー。

sourceを390×844へ密度正規化し、実装と一緒に並べた `comparison-goal-list-final.png` を開いて比較。メニュー・説明の拡大画像でも文字と操作領域を確認した。旧比較は `comparison-goal-list.png`、説明画面の前後は `comparison-caption.png`。

## Findings / comparison history

- [P2, fixed] 写真説明が大きくボードを隠し、配置設定が常時露出していた。下部シートへ変更し任意設定を折りたたみ、テキスト欄の自動フォーカスをやめた。旧 `implementation-before-caption.png` と再取得した最終画面で比較。最終シート高さ435px、背景の文脈を残す。説明だけの保存で位置・回転を保つ試験も成功。
- [P2, fixed] 写真カードの余白と写真が大きすぎた。写真高120px、カード内余白・手段の行間を調整。同一寸法で再取得し比較。旧証拠 `implementation-before-density.png`、最終 `implementation-goal-cards.png`。
- 画像案の上部追加ボタンは、ユーザーの後の指定で共通＋へ置換。これは意図した変更であり、元に戻さない。

## Required fidelity surfaces

- Typography：既存の日本語system font、明確な見出し、カード本文14px・入力16px。日本語ラベルに切れなし、長文は折返し。
- Layout：3つの表示、独立目的リスト、写真カード、＋を一か所。390pxで本文横はみ出しなし。タブ列だけ横スクロール。44pxのタップ領域と既存ヘッダー寸法を維持。
- Colors：既存の紺・ミントとテーマ変数。生成画像案の装飾グラデーションは導入せず、既存12テーマへの対応を維持。青い＋は既存FABに合わせた。
- Images：コルクと透明画鋲は実ラスタ素材。CSSによる代用品なし。カードとボードは同じattachment_id。生成した旅行/机写真は確認用だけで、利用者の初期データではない。
- Copy：目的/目標/手段を区別。＋で追加対象を選べ、写真から関連目標へ移動可能。未依頼の分析や進捗指標は追加していない。

## Interactions / limits

独立一覧、親フィルター、＋からの入力、複数手段、画像共有と表紙ON/OFF、説明・回転、移動確定/キャンセル、横タブ順保存、オフライン再読込、遅延取得/アップロードを隔離試験で確認。IABでも一覧・メニュー・入力画面・ボード・説明を確認した。キャプチャ記録は外部通信・書込み・page errorなし。

Service Workerはプレビューで意図的に無効化。本番GAS、iPhoneのネイティブ入力・写真選択は未確認。

残る[P3]：画像案と画面内の密度は厳密一致ではなく、既存ヘッダーと44px操作領域を優先。増えた一覧は指定どおり縦スクロールする。永続操作を隠すはみ出しはない。未解決のP0/P1/P2なし。本番公開をこのQA結果で実施済みと扱わない。

## 写真操作の追記（2026-11-24）

ユーザーの指定により、写真の移動はモード切替から長押しへ変更。短タップは削除等を含むメニューを表示する。番号ではなく画面名で案内する。基礎のコルク/写真配置と既存の一覧は維持している。

最新証拠： `/Users/basabasa/Documents/Codex/2026-11-24/task-6/goals-ui/implementation-photo-menu.png`、390×844。メニュー内の編集/傾き/削除/閉じるの日本語ラベルと48px操作領域、背景との分離、コルクの文脈を目視確認。IABでも短タップ表示と600ms長押し後のメニュー非表示を確認した。

影響する操作10項目は成功、既存のキャッシュ/同期契約25項目も成功。元の画像・目標の保持と削除取消、長押し確定時のみ保存、各キャンセルの復元を確認。iPhone実機・本番反映は未実施。新たなP0/P1/P2なし、final result: passed を維持する。

## 2026-11-24 切り替え項目の固定

- 「目的一覧・目標一覧・ビジョンボード」の切り替え行を `#scroll-container` 上端に sticky で固定。背景は既存テーマに追従し、本文の透けを防止。余白は従来どおり。保存処理の変更なし。
- 390×844 の確認用 HTTPS 画面で、スクロール量 0 → 241.5px に対し、行の上端は 110px のまま、主タブ下端と一致。カード本文のみ移動。スクロール後のボード切り替えも確認。
- 別担当による CSS 構造の読み取りレビュー済み。試作サーバー更新時に目標・画像を退避・復元し、データ一致を確認。
- 確認画像: `/Users/basabasa/Documents/Codex/2026-11-24/task-6/goals-ui/implementation-fixed-goal-tabs.jpg`。実機 iPhone は未確認。
