export function calculateProjectState(config, githubIssues) {
  const errors = [];
  const milestones = new Map(config.milestones.map((m) => [m.id, m]));
  const categories = new Set(config.categories.map((c) => c.id));
  const githubByNumber = new Map(githubIssues.map((issue) => [issue.number, issue]));
  const configuredNumbers = new Set();
  const executions = [];

  for (const definition of config.issues || []) {
    if (configuredNumbers.has(definition.number)) {
      errors.push(`#${definition.number}: project.json に重複定義があります`);
      continue;
    }
    configuredNumbers.add(definition.number);

    if (!milestones.has(definition.milestone)) {
      errors.push(`#${definition.number}: 未知のmilestone "${definition.milestone}"`);
    }
    if (!categories.has(definition.category)) {
      errors.push(`#${definition.number}: 未知のcategory "${definition.category}"`);
    }
    if (!Array.isArray(definition.depends_on)) {
      errors.push(`#${definition.number}: depends_on は配列である必要があります`);
      definition.depends_on = [];
    }
    if (definition.verify_gate === true && definition.category !== "VERIFY") {
      errors.push(`#${definition.number}: verify_gate=true は VERIFY category にしてください`);
    }
    if (!githubByNumber.has(definition.number)) {
      errors.push(`#${definition.number}: GitHub Issue が存在しません`);
    }

    const github = githubByNumber.get(definition.number);
    executions.push({
      number: definition.number,
      title: github?.title || `Issue #${definition.number}`,
      github_state: github?.github_state || "missing",
      meta: {...definition},
      status: null,
      unresolved: []
    });
  }

  const byNumber = new Map(executions.map((issue) => [issue.number, issue]));

  for (const issue of executions) {
    for (const dep of issue.meta.depends_on) {
      if (!Number.isInteger(dep)) {
        errors.push(`#${issue.number}: dependency "${dep}" はIssue番号ではありません`);
      } else if (!byNumber.has(dep)) {
        errors.push(`#${issue.number}: dependency #${dep} は project.json に定義されていません`);
      }
    }
  }

  for (const cycle of findCycles(byNumber)) {
    errors.push(`依存循環: ${cycle.map((n) => `#${n}`).join(" → ")}`);
  }

  for (const milestone of config.milestones) {
    const gates = executions.filter((issue) =>
      issue.meta.milestone === milestone.id &&
      issue.meta.required !== false &&
      issue.meta.verify_gate === true
    );
    if (gates.length !== 1) {
      errors.push(`${milestone.id}: required verify_gate は1件必要です（現在 ${gates.length}件）`);
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

    if (issue.meta.manual_state === "blocked" || issue.unresolved.length > 0) {
      issue.status = "BLOCKED";
    } else if (issue.meta.manual_state === "doing") {
      issue.status = "ACTIVE";
    } else {
      issue.status = "READY";
    }
  }

  const milestoneStates = new Map();
  const sortedMilestones = [...config.milestones].sort((a, b) => a.order - b.order);

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

  const firstIncomplete = sortedMilestones.find((m) => milestoneStates.get(m.id) !== "VERIFIED") || null;
  const focus = firstIncomplete
    ? executions
        .filter((issue) =>
          issue.meta.milestone === firstIncomplete.id &&
          (issue.status === "ACTIVE" || issue.status === "READY")
        )
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
          return a.number - b.number;
        })
    : [];

  return {executions, milestoneStates, errors, sortedMilestones, firstIncomplete, focus};
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
    for (const dep of issue?.meta.depends_on || []) {
      if (byNumber.has(dep)) walk(dep);
    }
    stack.pop();
    visiting.delete(number);
    visited.add(number);
  }

  for (const number of byNumber.keys()) walk(number);
  return cycles;
}
