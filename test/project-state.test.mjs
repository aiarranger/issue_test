import assert from "node:assert/strict";
import test from "node:test";
import {calculateProjectState} from "../lib/project-state.mjs";

function config(manual2 = null) {
  return {
    categories: ["PLATFORM", "DATA", "APP", "VERIFY", "OPS"].map((id) => ({id})),
    milestones: [{id: "M0", label: "入れる", order: 0}],
    issues: [
      {number:2,milestone:"M0",category:"PLATFORM",required:true,depends_on:[],manual_state:manual2},
      {number:3,milestone:"M0",category:"DATA",required:true,depends_on:[2]},
      {number:4,milestone:"M0",category:"APP",required:true,depends_on:[2,3]},
      {number:5,milestone:"M0",category:"VERIFY",required:true,verify_gate:true,depends_on:[4]}
    ]
  };
}

function github({p2="open",p3="open",p4="open",p5="open"} = {}) {
  return [
    {number:2,title:"platform",github_state:p2},
    {number:3,title:"data",github_state:p3},
    {number:4,title:"app",github_state:p4},
    {number:5,title:"verify",github_state:p5}
  ];
}

function states(result) {
  return Object.fromEntries(result.executions.map((i) => [i.number, i.status]));
}

test("初期状態はM0 NOT STARTEDで#2だけREADY", () => {
  const r = calculateProjectState(config(), github());
  assert.equal(r.milestoneStates.get("M0"), "NOT STARTED");
  assert.deepEqual(states(r), {2:"READY",3:"BLOCKED",4:"BLOCKED",5:"BLOCKED"});
  assert.deepEqual(r.focus.map((i) => i.number), [2]);
});

test("project.jsonで#2をdoingにするとM0 BUILDING", () => {
  const r = calculateProjectState(config("doing"), github());
  assert.equal(r.milestoneStates.get("M0"), "BUILDING");
  assert.equal(states(r)[2], "ACTIVE");
});

test("#2 Closeで#3がREADY", () => {
  const r = calculateProjectState(config(), github({p2:"closed"}));
  assert.equal(r.milestoneStates.get("M0"), "BUILDING");
  assert.deepEqual(states(r), {2:"DONE",3:"READY",4:"BLOCKED",5:"BLOCKED"});
});

test("実装完了でREADY TO VERIFY", () => {
  const r = calculateProjectState(config(), github({p2:"closed",p3:"closed",p4:"closed"}));
  assert.equal(r.milestoneStates.get("M0"), "READY TO VERIFY");
  assert.equal(states(r)[5], "READY");
});

test("VERIFYをdoingにするとVERIFYING", () => {
  const c = config();
  c.issues.find((i) => i.number === 5).manual_state = "doing";
  const r = calculateProjectState(c, github({p2:"closed",p3:"closed",p4:"closed"}));
  assert.equal(r.milestoneStates.get("M0"), "VERIFYING");
});

test("全CloseでVERIFIED", () => {
  const r = calculateProjectState(config(), github({p2:"closed",p3:"closed",p4:"closed",p5:"closed"}));
  assert.equal(r.milestoneStates.get("M0"), "VERIFIED");
});

test("VERIFIED後に#4をreopenするとBUILDINGへ戻る", () => {
  const r = calculateProjectState(config(), github({p2:"closed",p3:"closed",p4:"open",p5:"closed"}));
  assert.equal(r.milestoneStates.get("M0"), "BUILDING");
  assert.equal(states(r)[4], "READY");
});

test("依存循環を構造エラーとして検出", () => {
  const c = config();
  c.issues.find((i) => i.number === 2).depends_on = [4];
  const r = calculateProjectState(c, github());
  assert.ok(r.errors.some((e) => e.startsWith("依存循環:")));
});

test("未定義dependencyを構造エラーとして検出", () => {
  const c = config();
  c.issues.find((i) => i.number === 2).depends_on = [99];
  const r = calculateProjectState(c, github());
  assert.ok(r.errors.some((e) => e.includes("#99") && e.includes("project.json")));
});
