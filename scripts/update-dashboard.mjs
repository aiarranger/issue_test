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

function issueStatus(status) {
  return {READY:"Ready", ACTIVE:"Doing", BLOCKED:"Blocked", DONE:"Done"}[status] || status;
}

function issueIcon(status) {
  return {READY:"○", ACTIVE:"🔨", BLOCKED:"⏳", DONE:"✅"}[status] || "";
}

function milestoneStatus(status) {
  return {
    "NOT STARTED":"Not started",
    BUILDING:"Building",
    BLOCKED:"Blocked",
    "READY TO VERIFY":"Ready for QA",
    VERIFYING:"QA",
    VERIFIED:"Verified"
  }[status] || status;
}

function milestoneIcon(status) {
  return {
    "NOT STARTED":"○",
    BUILDING:"🔨",
    BLOCKED:"⛔",
    "READY TO VERIFY":"👀",
    VERIFYING:"👀",
    VERIFIED:"✅"
  }[status] || "";
}

function cleanForMermaid(text) {
  return String(text).replaceAll('"', "'").replaceAll("\n", " ");
}

const githubIssues = (await listIssues()).map((issue) => ({
  number: issue.number,
  title: issue.title,
  github_state: issue.state
}));

const result = calculateProjectState(config, githubIssues);
const lines = [];

lines.push("# AISNS Issue Map", "");
lines.push("**Goal:** " + config.goal, "");

lines.push("## Issue Map", "");
lines.push("| Milestone | Status | " + config.categories.map((c) => c.label).join(" | ") + " |");
lines.push("|---|---|" + config.categories.map(() => "---").join("|") + "|");

for (const milestone of result.sortedMilestones) {
  const cells = config.categories.map((category) => {
    const matches = result.executions
      .filter((issue) => issue.meta.milestone === milestone.id && issue.meta.category === category.id)
      .sort((a,b) => a.number - b.number);
    return matches.length
      ? matches.map((issue) =>
          "#" + issue.number + " " + issue.title + "<br>" +
          issueIcon(issue.status) + " " + issueStatus(issue.status)
        ).join("<br><br>")
      : "—";
  });
  const state = result.milestoneStates.get(milestone.id);
  lines.push("| **" + milestone.id + " " + milestone.label + "** | " +
    milestoneIcon(state) + " " + milestoneStatus(state) + " | " + cells.join(" | ") + " |");
}

lines.push("", "## Next", "");
if (!result.firstIncomplete) {
  lines.push("✅ All milestones verified.");
} else if (result.focus.length) {
  for (const issue of result.focus) {
    lines.push("- " + issueIcon(issue.status) + " **#" + issue.number + " " + issue.title + "** — " + issueStatus(issue.status));
  }
} else {
  const blocked = result.executions.filter((i) =>
    i.meta.milestone === result.firstIncomplete.id && i.status === "BLOCKED"
  );
  for (const issue of blocked) {
    const reason = issue.meta.manual_state === "blocked"
      ? "manual block"
      : "waiting for " + issue.unresolved.map((n) => "#" + n).join(", ");
    lines.push("- ⏳ **#" + issue.number + " " + issue.title + "** — " + reason);
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

  lines.push("", "<details>", "<summary>Dependencies</summary>", "", "```mermaid", "flowchart LR");
  for (const issue of graphIssues) {
    lines.push("N" + issue.number + '["#' + issue.number + " " + cleanForMermaid(issue.title) + "<br>" + issueStatus(issue.status) + '"]');
  }
  for (const issue of focusIssues) {
    for (const dep of issue.meta.depends_on) {
      if (focusNumbers.has(dep)) lines.push("N" + dep + " --> N" + issue.number);
    }
  }
  lines.push("```", "", "</details>");
}

lines.push("", "<details>", "<summary>System</summary>", "");
if (result.errors.length === 0) lines.push("✅ Structure OK");
else for (const error of result.errors) lines.push("- ⚠️ " + error);
lines.push("");
lines.push("- Source of truth: `project.json`");
lines.push("- Done: close the GitHub Issue");
lines.push("- No percentage progress");
lines.push("", "</details>", "");
lines.push("_Updated: " + new Date().toISOString() + "_");

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
