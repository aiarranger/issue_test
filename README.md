# AISNS Issue Dashboard Prototype

Issueを作業の正本にしつつ、現在地をLLMなしで機械的に可視化する試作です。

## 正本

- `project.json`: ゴール、Milestone、Category、Issue所属、依存、手動状態
- GitHub Issueの `open / closed`: 完了状態
- Dashboard Issue #19: 派生表示。直接編集した内容は正本ではない

Issue本文にある旧 `AISNS_STATE` コメントは互換用の残骸で、現在の計算では読みません。

## project.json のIssue定義

例:

```json
{
  "number": 4,
  "milestone": "M0",
  "category": "APP",
  "required": true,
  "depends_on": [2, 3],
  "manual_state": null
}
```

`manual_state`:
- `null`: 依存が解消していればREADY
- `"doing"`: ACTIVE
- `"blocked"`: 手動BLOCKED

IssueをCloseするとDONEです。

## 自動状態

Issue:
- READY
- ACTIVE
- BLOCKED
- DONE

Milestone:
- NOT STARTED
- BUILDING
- BLOCKED
- READY TO VERIFY
- VERIFYING
- VERIFIED

Issue更新時と `project.json` / 状態ロジック変更時にGitHub Actionsが再計算し、#19を書き換えます。

## テスト

`node --test test/project-state.test.mjs`

状態遷移、再open、依存循環、未定義dependencyをLLMなしで検証します。
