import fs from "node:fs/promises";
import {calculateProjectState} from "../lib/project-state.mjs";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");

const config = JSON.parse(await fs.readFile(new URL("../project.json", import.meta.url), "utf8"));
const [owner, repo] = repository.split("/");
const api = "https://api.github.com";
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: "Bearer " + token,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "aisns-issue-dashboard"
};

async function gh(path, options = {}) {
  const response = await fetch(api + path, {...options, headers: {...headers, ...(options.headers || {})}});
  if (!response.ok) throw new Error("GitHub API " + response.status + ": " + await response.text());
  if (response.status === 204) return null;
  return response.json();
}

async function listIssues() {
  const all = [];
  for (let page = 1; ; page += 1) {
    const rows = await gh("/repos/" + owner + "/" + repo + "/issues?state=all&per_page=100&page=" + page + "&sort=created&direction=asc");
    all.push(...rows.filter((issue) => !issue.pull_request));
    if (rows.length < 100) break;
  }
  return all;
}

function issueIcon(status) {
  return {READY:"○", ACTIVE:"▶", BLOCKED:"⛔", DONE:"✅"}[status] || "?";
}

function milestoneIcon(status) {
  return {"NOT STARTED":"○", BUILDING:"▶", BLOCKED:"⛔", "READY TO VERIFY":"👀", VERIFYING:"🔎", VERIFIED:"✅"}[status] || "?";
}

const githubIssues = (await listIssues()).map((issue) => ({
  number: issue.number,
  title: issue.title,
  github_state: issue.state
}));

const result = calculateProjectState(config, githubIssues);
const lines = [];

lines.push("# AISNS Project Dashboard", "");
lines.push("> CIが自動生成します。正本は `project.json` とGitHub Issueのopen/closedです。", "");
lines.push("**Goal:** " + config.goal, "", "## 現在地", "");
lines.push("| Milestone | 状態 | " + config.categories.map((c) => c.id).join(" | ") + " |");
lines.push("|---|---|" + config.categories.map(() => "---").join("|") + "|");

for (const milestone of result.sortedMilestones) {
  const cells = config.categories.map((category) => {
    const matches = result.executions
      .filter((issue) => issue.meta.milestone === milestone.id && issue.meta.category === category.id)
      .sort((a,b) => a.number - b.number);
    return matches.length
      ? matches.map((issue) => "#" + issue.number + " " + issueIcon(issue.status) + " " + issue.status).join("<br>")
      : "—";
  });
  const state = result.milestoneStates.get(milestone.id);
  lines.push("| **" + milestone.id + " " + milestone.label + "** | " + milestoneIcon(state) + " **" + state + "** | " + cells.join(" | ") + " |");
}

lines.push("", "## 次に見るもの", "");

if (!result.firstIncomplete) {
  lines.push("✅ すべてのMilestoneがVERIFIEDです。");
} else {
  lines.push("現在の焦点: **" + result.firstIncomplete.id + " " + result.firstIncomplete.label + " — " + result.milestoneStates.get(result.firstIncomplete.id) + "**", "");
  if (result.focus.length) {
    for (const issue of result.focus) {
      lines.push("- " + issueIcon(issue.status) + " **#" + issue.number + " " + issue.status + "** — " + issue.title);
    }
  } else {
    for (const issue of result.executions.filter((i) => i.meta.milestone === result.firstIncomplete.id && i.status === "BLOCKED")) {
      const reason = issue.meta.manual_state === "blocked"
        ? "manual blocked"
        : "待ち: " + issue.unresolved.map((n) => "#" + n).join(", ");
      lines.push("- ⛔ **#" + issue.number + " BLOCKED** — " + reason);
    }
  }
}

if (result.firstIncomplete) {
  const focusMilestoneId = result.firstIncomplete.id;
  const focusIssues = result.executions.filter((issue) => issue.meta.milestone === focusMilestoneId);
  const focusNumbers = new Set(focusIssues.map((issue) => issue.number));
  for (const issue of focusIssues) {
    for (const dep of issue.meta.depends_on) focusNumbers.add(dep);
  }
  const graphIssues = result.executions.filter((issue) => focusNumbers.has(issue.number));

  lines.push("", "<details>", "<summary>現在の依存関係</summary>", "", "\`\`\`mermaid", "flowchart LR");
  for (const issue of graphIssues) {
    lines.push("N" + issue.number + '["#' + issue.number + " " + issue.meta.category + " / " + issue.status + '"]');
  }
  for (const issue of focusIssues) {
    for (const dep of issue.meta.depends_on) {
      if (focusNumbers.has(dep)) lines.push("N" + dep + " --> N" + issue.number);
    }
  }
  lines.push("\`\`\`", "", "</details>");
}

lines.push("", "## 構造チェック", "");
if (result.errors.length === 0) lines.push("✅ 構造エラーなし");
else for (const error of result.errors) lines.push("- ⚠️ " + error);

lines.push("", "<details>", "<summary>状態ルール</summary>", "");
lines.push("- 構造・依存・手動状態: project.json");
lines.push("- 完了: GitHub IssueのClose");
lines.push("- Issue: READY / ACTIVE / BLOCKED / DONE");
lines.push("- Milestone: NOT STARTED / BUILDING / BLOCKED / READY TO VERIFY / VERIFYING / VERIFIED");
lines.push("- 進捗率は計算しません。");
lines.push("- Issue本文の説明文・チェックボックスは状態計算に使いません。", "", "</details>", "");
lines.push("_Last recalculated: " + new Date().toISOString() + "_");

const dashboardBody = lines.join("\n");

await gh("/repos/" + owner + "/" + repo + "/issues/" + config.dashboard_issue, {
  method: "PATCH",
  headers: {"Content-Type":"application/json"},
  body: JSON.stringify({body: dashboardBody})
});

if (process.env.GITHUB_STEP_SUMMARY) {
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, dashboardBody + "\n");
}

console.log(JSON.stringify({
  dashboard_issue: config.dashboard_issue,
  structural_errors: result.errors.length,
  milestone_states: Object.fromEntries(result.milestoneStates),
  next: result.focus.map((issue) => issue.number)
}, null, 2));
