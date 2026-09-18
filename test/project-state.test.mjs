import assert from "node:assert/strict";
import test from "node:test";
import {calculateProjectState} from "../lib/project-state.mjs";

const config = {
  categories: ["PLATFORM", "DATA", "APP", "VERIFY", "OPS"].map((id) => ({id})),
  milestones: [{id: "M0", label: "入れる", order: 0}]
};

function fixture({p2="open", p3="open", p4="open", p5="open", doing2=false} = {}) {
  return [
    {number:2,title:"platform",github_state:p2,meta:{type:"execution",milestone:"M0",category:"PLATFORM",required:true,depends_on:[],doing:doing2}},
    {number:3,title:"data",github_state:p3,meta:{type:"execution",milestone:"M0",category:"DATA",required:true,depends_on:[2]}},
    {number:4,title:"app",github_state:p4,meta:{type:"execution",milestone:"M0",category:"APP",required:true,depends_on:[2,3]}},
    {number:5,title:"verify",github_state:p5,meta:{type:"execution",milestone:"M0",category:"VERIFY",required:true,verify_gate:true,depends_on:[4]}}
  ];
}

function states(result) {
  return Object.fromEntries(result.executions.map((i) => [i.number, i.status]));
}

test("初期状態はM0 NOT STARTEDで#2だけREADY", () => {
  const r = calculateProjectState(config, fixture());
  assert.equal(r.milestoneStates.get("M0"), "NOT STARTED");
  assert.deepEqual(states(r), {2:"READY",3:"BLOCKED",4:"BLOCKED",5:"BLOCKED"});
  assert.deepEqual(r.focus.map((i) => i.number), [2]);
});

test("#2を開始するとM0 BUILDING", () => {
  const r = calculateProjectState(config, fixture({doing2:true}));
  assert.equal(r.milestoneStates.get("M0"), "BUILDING");
  assert.equal(states(r)[2], "ACTIVE");
});

test("#2完了で#3がREADY", () => {
  const r = calculateProjectState(config, fixture({p2:"closed"}));
  assert.equal(r.milestoneStates.get("M0"), "BUILDING");
  assert.deepEqual(states(r), {2:"DONE",3:"READY",4:"BLOCKED",5:"BLOCKED"});
});

test("実装完了でREADY TO VERIFY", () => {
  const r = calculateProjectState(config, fixture({p2:"closed",p3:"closed",p4:"closed"}));
  assert.equal(r.milestoneStates.get("M0"), "READY TO VERIFY");
  assert.equal(states(r)[5], "READY");
});

test("VERIFY実行中はVERIFYING", () => {
  const issues = fixture({p2:"closed",p3:"closed",p4:"closed"});
  issues.find((i) => i.number === 5).meta.doing = true;
  const r = calculateProjectState(config, issues);
  assert.equal(r.milestoneStates.get("M0"), "VERIFYING");
});

test("全完了でVERIFIED", () => {
  const r = calculateProjectState(config, fixture({p2:"closed",p3:"closed",p4:"closed",p5:"closed"}));
  assert.equal(r.milestoneStates.get("M0"), "VERIFIED");
});

test("VERIFIED後に#4をreopenするとBUILDINGへ戻る", () => {
  const r = calculateProjectState(config, fixture({p2:"closed",p3:"closed",p4:"open",p5:"closed"}));
  assert.equal(r.milestoneStates.get("M0"), "BUILDING");
  assert.equal(states(r)[4], "READY");
});
