import assert from "node:assert/strict";
import { parseReminder as P, planReminder as plan } from "./parser.js";
import { buildSpeech } from "./speech.js";

const at = (h, mi = 0, d = 19) => new Date(2026, 10, d, h, mi, 0, 0);
const NOW = at(9, 30);
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("PASS", name); }
  catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message.split("\n")[0]); }
};
const same = (a, b) => assert.equal(a.getTime(), b.getTime(), `${a} != ${b}`);

t("R1 original: tournament on 20th November", () => {
  const p = P("I have a tournament on 20th November", NOW);
  assert.equal(p.ok, true); assert.equal(p.title, "Tournament"); same(p.at, at(9, 0, 20));
  same(plan(p, NOW).fireAt, at(18, 0, 19));
});
t("R2 original: invalid date 31st February rejected", () => assert.equal(P("party on 31st February", NOW).ok, false));
t("R3 original: no date gives an error", () => assert.equal(P("blah blah", NOW).ok, false));
t("R4 original: empty input gives an error", () => assert.equal(P("   ", NOW).ok, false));
t("R5 original: past date rolls to next year", () => {
  const p = P("exam on 5th March", NOW); same(p.at, new Date(2027, 2, 5, 9, 0));
});
t("B1 fixed: evening reminder passed falls back to 8 AM that day", () => {
  const n = at(19, 0), p = P("I have a tournament on 20th November", n);
  same(plan(p, n).fireAt, at(8, 0, 20));
});
t("B2 fixed: event today after 9 AM is not pushed to next year", () => {
  const n = at(10, 0), p = P("dentist on 19th November", n);
  same(p.at, at(9, 0, 19));
  assert.ok(plan(p, n).fireAt - n === 60000);
});
t("B3 fixed: no double spaces in title", () => assert.equal(P("20th November tournament", NOW).title, "Tournament"));
t("B4 fixed: leap day goes to next real Feb 29", () => same(P("party on 29th February", NOW).at, new Date(2028, 1, 29, 9, 0)));
t("N1 new: Month Day with time", () => same(P("November 20 meeting at 3pm", NOW).at, at(15, 0, 20)));
t("N2 new: tomorrow at 7 pm", () => {
  const p = P("tomorrow at 7 pm call mom", NOW); same(p.at, at(19, 0, 20)); assert.equal(p.title, "Call mom");
});
t("N3 new: in 30 minutes", () => {
  const p = P("in 30 minutes take medicine", NOW); same(p.at, at(10, 0)); assert.equal(p.title, "Take medicine");
});
t("N4 new: weekday (Monday = Nov 23)", () => same(P("monday at 8 am", NOW).at, at(8, 0, 23)));
t("N5 new: every day repeat", () => {
  const p = P("every day at 6:30 am gym", NOW); assert.equal(p.repeat, "daily"); same(p.at, at(6, 30, 20)); assert.equal(p.title, "Gym");
});
t("N6 new: bare hour picks next future time", () => same(P("stretch at 7", NOW).at, at(19, 0)));
t("N7 new: invalid time rejected", () => assert.equal(P("call at 25:99", NOW).ok, false));
t("S1 scenario: school wake up at 10:45 (before 10:45) is an alarm today", () => {
  const p = P("school wake up at 10:45", NOW);
  assert.equal(p.kind, "alarm"); assert.equal(p.title, "School wake up"); same(p.at, at(10, 45));
});
t("S2 scenario: after 10:45 it rolls to tomorrow, AM", () => {
  const n = at(22, 42), p = P("set me school wake up reminder at 10:45", n);
  assert.equal(p.title, "School wake up"); assert.equal(p.kind, "alarm"); same(p.at, at(10, 45, 20));
});

t("V1 v2: tablet at 12:30 resolves to 12:30 PM today", () => {
  const p = P("remind me to take my tablet at 12:30", NOW);
  assert.equal(p.title, "Take my tablet"); same(p.at, at(12, 30));
});
t("V2 v2: after 12:30 PM it rolls to 12:30 PM tomorrow, not midnight", () => {
  same(P("remind me to take my tablet at 12:30", at(13, 0)).at, at(12, 30, 20));
});
t("V3 v2: 'at 5' prefers 5 PM", () => same(P("walk at 5", NOW).at, at(17, 0)));
t("T1 speech: tablet phrase", () => assert.equal(buildSpeech("Take my tablet"), "Hey, you just need to take your tablet. Don't skip it!"));
t("T2 speech: school wake up", () => assert.equal(buildSpeech("School wake up", "alarm"), "Good morning! It's time to wake up for school."));
t("T3 speech: generic reminder and alarm", () => {
  assert.equal(buildSpeech("Call mom"), "Hey, a quick reminder: Call mom.");
  assert.equal(buildSpeech("Stretch", "alarm"), "Alarm! Stretch.");
});
t("T4 speech: empty title is safe", () => assert.equal(buildSpeech(""), "Hey, a quick reminder: your reminder."));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
