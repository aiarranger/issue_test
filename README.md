# AISNS Issue Dashboard Prototype

このリポジトリは、Issueを作業の正本にしつつ、現在地をLLMなしで機械的に可視化する試作です。

## 正本

- `project.json`: プロジェクト全体のゴール、Milestone、Category、Dashboard設定
- 各Issue先頭の `AISNS_STATE` JSON: Issueの構造化メタデータ
- GitHub Issueの open / closed: 完了状態

Dashboard Issue #19 は派生表示であり、直接編集した内容は正本ではありません。

## Issueメタデータ

各実行Issueの先頭に次の形式を置きます。

`<!-- AISNS_STATE {"type":"execution","milestone":"M0","category":"APP","required":true,"depends_on":[2],"doing":false} -->`

任意フィールド:
- `doing: true`: 現在作業中
- `blocked: true`: 依存関係とは別に手動で停止
- `verify_gate: true`: Milestoneの人間確認Issue

## 自動状態

Issue:
- READY: open・依存解消・doing=false
- ACTIVE: open・doing=true
- BLOCKED: open・未完了dependencyあり、またはblocked=true
- DONE: closed

Milestone:
- NOT STARTED
- BUILDING
- BLOCKED
- READY TO VERIFY
- VERIFYING
- VERIFIED

Issue更新時と `project.json` / Dashboardスクリプト変更時にGitHub Actionsが再計算し、#19を書き換えます。
