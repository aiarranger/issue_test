import fs from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");

const config = JSON.parse(await fs.readFile(new URL("../project.json", import.meta.url), "utf8"));
const parts = repository.split("/");
const owner = parts[0];
const repo = parts[1];
const api = "https://api.github.com";
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: "Bearer " + token,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "aisns-issue-dashboard"
};

async function gh(path, options = {}) {
  const response = await fetch(api + path, {
    ...options,
    headers: {...headers, ...(options.headers || {})}
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error("GitHub API " + response.status + ": " + body);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function listIssues() {
  const all = [];
  for (let page = 1; ; page += 1) {
    const path = "/repos/" + owner + "/" + repo +
      "/issues?state=all&per_page=100&page=" + page +
      "&sort=created&direction=asc";
    const rows = await gh(path);
    all.push(...rows.filter((issue) => !issue.pull_request));
    if (rows.length < 100) break;
  }
  return all;
}

function parseMeta(issue) {
  const markerName = config.issue_metadata_marker || "AISNS_STATE";
  const marker = "<!-- " + markerName + " ";
  const body = issue.body || "";
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const end = body.indexOf(" -->", start + marker.length);
  if (end < 0) return {__parse_error: "closing marker not found"};
  const jsonText = body.slice(start + marker.length, end);
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    return {__parse_error: error.message};
  }
}

function issueIcon(status) {
  return {READY:"○", ACTIVE:"▶", BLOCKED:"⛔", DONE:"✅"}[status] || "?";
}

function milestoneIcon(status) {
  return {
    "NOT STARTED":"○",
    BUILDING:"▶",
    BLOCKED:"⛔",
    "READY TO VERIFY":"👀",
    VERIFYING:"🔎",
    VERIFIED:"✅"
  }[status] || "?";
}

function findCycles(byNumber) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];

  function walk(number) {
    if (visiting.has(number)) {
      const start = stack.indexOf(number);
      cycles.push([...stack.slice(start), number]);
      return;
    }
    if (visited.has(number)) return;
    visiting.add(number);
    stack.push(number);
    const issue = byNumber.get(number);
    for (const dep of (issue && issue.meta.depends_on) || []) {
      if (byNumber.has(dep)) walk(dep);
    }
    stack.pop();
    visiting.delete(number);
    visited.add(number);
  }

  for (const number of byNumber.keys()) walk(number);
  return cycles;
}

const issues = await listIssues();
const milestoneConfig = new Map(config.milestones.map((m) => [m.id, m]));
const categoryIds = new Set(config.categories.map((c) => c.id));
const allByNumber = new Map(issues.map((issue) => [issue.number, issue]));
const errors = [];
const executions = [];

for (const issue of issues) {
  const meta = parseMeta(issue);
  if (!meta) continue;
  if (meta.__parse_error) {
    errors.push("#" + issue.number + ": AISNS_STATE JSONが壊れています (" + meta.__parse_error + ")");
    continue;
  }
  if (meta.type !== "execution") continue;

  if (!milestoneConfig.has(meta.milestone)) {
    errors.push("#" + issue.number + ': 未知のmilestone "' + meta.milestone + '"');
  }
  if (!categoryIds.has(meta.category)) {
    errors.push("#" + issue.number + ': 未知のcategory "' + meta.category + '"');
  }
  if (!Array.isArray(meta.depends_on)) {
    errors.push("#" + issue.number + ": depends_on は配列である必要があります");
    meta.depends_on = [];
  }
  if (meta.verify_gate === true && meta.category !== "VERIFY") {
    errors.push("#" + issue.number + ": verify_gate=true は VERIFY category にしてください");
  }

  executions.push({
    number: issue.number,
    title: issue.title,
    github_state: issue.state,
    meta,
    status: null,
    unresolved: []
  });
}

const byNumber = new Map(executions.map((issue) => [issue.number, issue]));

for (const issue of executions) {
  for (const dep of issue.meta.depends_on) {
    if (!Number.isInteger(dep)) {
      errors.push("#" + issue.number + ': dependency "' + dep + '" はIssue番号ではありません');
      continue;
    }
    if (!allByNumber.has(dep)) {
      errors.push("#" + issue.number + ": dependency #" + dep + " が存在しません");
    } else if (!byNumber.has(dep)) {
      errors.push("#" + issue.number + ": dependency #" + dep + " はexecution Issueではありません");
    }
  }
}

for (const cycle of findCycles(byNumber)) {
  errors.push("依存循環: " + cycle.map((n) => "#" + n).join(" → "));
}

for (const milestone of config.milestones) {
  const gates = executions.filter((issue) =>
    issue.meta.milestone === milestone.id &&
    issue.meta.required !== false &&
    issue.meta.verify_gate === true
  );
  if (gates.length !== 1) {
    errors.push(milestone.id + ": required verify_gate は1件必要です（現在 " + gates.length + "件）");
  }
}

for (const issue of executions) {
  if (issue.github_state === "closed") {
    issue.status = "DONE";
    continue;
  }
  issue.unresolved = issue.meta.depends_on.filter((number) => {
    const dep = byNumber.get(number);
    return !dep || dep.github_state !== "closed";
  });
  if (issue.meta.blocked === true || issue.unresolved.length > 0) {
    issue.status = "BLOCKED";
  } else if (issue.meta.doing === true) {
    issue.status = "ACTIVE";
  } else {
    issue.status = "READY";
  }
}

const milestoneStates = new Map();
const sortedMilestones = [...config.milestones].sort((a,b) => a.order - b.order);

for (const milestone of sortedMilestones) {
  const required = executions.filter((issue) =>
    issue.meta.milestone === milestone.id && issue.meta.required !== false
  );
  const gates = required.filter((issue) => issue.meta.verify_gate === true);
  const implementation = required.filter((issue) => issue.meta.verify_gate !== true);
  const allImplDone = implementation.length > 0 && implementation.every((issue) => issue.status === "DONE");
  const allDone = required.length > 0 && required.every((issue) => issue.status === "DONE");
  const started = implementation.some((issue) => issue.status === "ACTIVE" || issue.status === "DONE");
  const unfinished = implementation.filter((issue) => issue.status !== "DONE");
  const actionable = unfinished.filter((issue) => issue.status === "READY" || issue.status === "ACTIVE");

  let status = "NOT STARTED";
  if (allDone && gates.length === 1) {
    status = "VERIFIED";
  } else if (allImplDone && gates.length === 1) {
    status = gates[0].status === "ACTIVE" ? "VERIFYING" : "READY TO VERIFY";
  } else if (started && unfinished.length > 0 && actionable.length === 0) {
    status = "BLOCKED";
  } else if (started) {
    status = "BUILDING";
  }
  milestoneStates.set(milestone.id, status);
}

const lines = [];
lines.push("# AISNS Project Dashboard");
lines.push("");
lines.push("> CIが自動生成します。正本は project.json、各Issueの AISNS_STATE、GitHubのopen/closedです。");
lines.push("");
lines.push("**Goal:** " + config.goal);
lines.push("");
lines.push("## 現在地");
lines.push("");
lines.push("| Milestone | 状態 | " + config.categories.map((c) => c.id).join(" | ") + " |");
lines.push("|---|---|" + config.categories.map(() => "---").join("|") + "|");

for (const milestone of sortedMilestones) {
  const cells = config.categories.map((category) => {
    const matches = executions
      .filter((issue) => issue.meta.milestone === milestone.id && issue.meta.category === category.id)
      .sort((a,b) => a.number - b.number);
    return matches.length
      ? matches.map((issue) => "#" + issue.number + " " + issueIcon(issue.status) + " " + issue.status).join("<br>")
      : "—";
  });
  const state = milestoneStates.get(milestone.id);
  lines.push("| **" + milestone.id + " " + milestone.label + "** | " +
    milestoneIcon(state) + " **" + state + "** | " + cells.join(" | ") + " |");
}

const firstIncomplete = sortedMilestones.find((m) => milestoneStates.get(m.id) !== "VERIFIED");
const focus = firstIncomplete
  ? executions
      .filter((issue) =>
        issue.meta.milestone === firstIncomplete.id &&
        (issue.status === "ACTIVE" || issue.status === "READY"))
      .sort((a,b) => {
        if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
        return a.number - b.number;
      })
  : [];

lines.push("");
lines.push("## 次に見るもの");
lines.push("");

if (!firstIncomplete) {
  lines.push("✅ すべてのMilestoneがVERIFIEDです。");
} else {
  lines.push("現在の焦点: **" + firstIncomplete.id + " " + firstIncomplete.label +
    " — " + milestoneStates.get(firstIncomplete.id) + "**");
  lines.push("");
  if (focus.length > 0) {
    for (const issue of focus) {
      lines.push("- " + issueIcon(issue.status) + " **#" + issue.number + " " +
        issue.status + "** — " + issue.title);
    }
  } else {
    const blocked = executions.filter((issue) =>
      issue.meta.milestone === firstIncomplete.id && issue.status === "BLOCKED");
    for (const issue of blocked) {
      const reason = issue.meta.blocked === true
        ? "manual blocked"
        : "待ち: " + issue.unresolved.map((n) => "#" + n).join(", ");
      lines.push("- ⛔ **#" + issue.number + " BLOCKED** — " + reason);
    }
  }
}

lines.push("");
lines.push("## 構造チェック");
lines.push("");
if (errors.length === 0) {
  lines.push("✅ 構造エラーなし");
} else {
  for (const error of errors) lines.push("- ⚠️ " + error);
}

lines.push("");
lines.push("<details>");
lines.push("<summary>状態ルール</summary>");
lines.push("");
lines.push("- Issue: READY / ACTIVE / BLOCKED / DONE");
lines.push("- Milestone: NOT STARTED / BUILDING / BLOCKED / READY TO VERIFY / VERIFYING / VERIFIED");
lines.push("- 進捗率は計算しません。");
lines.push("- Issue本文の説明文・チェックボックスは状態計算に使いません。");
lines.push("");
lines.push("</details>");
lines.push("");
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
  structural_errors: errors.length,
  milestone_states: Object.fromEntries(milestoneStates),
  next: focus.map((issue) => issue.number)
}, null, 2));
