// The page's state machine (public/strip-state.js) with no DOM, no server and no port:
//
//   bun test test/state.test.ts
//
// Tables of cases for the transitions: a translation out of date after an edit, what a failed send
// leaves behind, our own draft against a real one, a chat change while the English is ready, the
// notices and their buttons, dictation's states. Made-up text only.
import { describe, expect, test } from "bun:test";
import "../public/strip-state.js";

const SS = (globalThis as any).StripState;
type St = any;

const ES = "¿Puedes revisar el presupuesto antes del jueves?";
const EN = "Could you take a look at the budget before Thursday?";
const PRIYA = { open: true, chat: "Priya Raman", from: "Priya Raman", last: "Could you send me the budget numbers before Thursday?", draft: false, shape: "ok" };
const DANIEL = { ...PRIYA, chat: "Daniel Okafor", from: "Daniel Okafor", last: "Thanks, see you then." };
const NOCHAT = { open: true, chat: null, from: null, last: null, draft: false, shape: "ok" };
const CLOSED = { open: false, chat: null, from: null, last: null, draft: false, shape: "ok" };
const UNKNOWN = { ...PRIYA, shape: "unknown" };
const SEVERAL = { ...PRIYA, shape: "several" };

// ---------------------------------------------------------------------------------------- helpers
// The two boxes, as the page reads them: a state writes one by bumping its counter.
type Boxes = { es: string; en: string };
const boxesOf = (st: St, was: St, b: Boxes): Boxes => ({
  es: st.esSeq !== was.esSeq ? st.esText : b.es,
  en: st.enSeq !== was.enSeq ? st.en : b.en,
});
// A strip in some state, with the boxes it would show: { st, f }.
function start(teams: any = PRIYA, access: any = { accessibility: true, microphone: "unknown" }) {
  let st = SS.create();
  st = SS.shellTeams(st, teams);
  st = SS.shellAccess(st, access).st;
  return { st, f: { es: "", en: "" } as Boxes };
}
type S = { st: St; f: Boxes };
function type(s: S, es: string): S { const f = { ...s.f, es }; return { st: SS.typed(s.st, f), f }; }
function applied(s: S, st: St): S { return { st, f: boxesOf(st, s.st, s.f) }; }
// Translate `es` and get `en` back.
function ready(es = ES, en = EN, teams: any = PRIYA, lint: any[] = []): S {
  let s = type(start(teams), es);
  const go = SS.translateStart(s.st, s.f);
  s = applied(s, go.st);
  return applied(s, SS.translateDone(s.st, s.f, { text: en, language: "English", from: "target", lint }));
}
const view = (s: S, srv: any = null) => SS.view(s.st, srv);
const tagOf = (s: S, srv: any = null) => { const v = view(s, srv); return v.tag ? `${v.tag.kind}: ${v.tag.text}` : null; };
const labels = (s: S, srv: any = null) => view(s, srv).actions.map((a: any) => a.label);
const canSend = (s: S, afterDraft = false) => SS.canSend(s.st, s.f, afterDraft);
function withTeams(s: S, teams: any): S { return { ...s, st: SS.shellTeams(s.st, teams) }; }
// Press Send and have the shell answer.
function sendAnd(s: S, answer: any, afterDraft = false): S {
  const go = SS.sendStart(s.st, s.f, afterDraft, "send");
  if (!go) throw new Error("Send was off");
  return applied(s, SS.sendDone(go.st, answer, "9:41 AM"));
}

// ---------------------------------------------------------------------------------------- translating
describe("translating", () => {
  test("a request carries the text, the register and what Teams shows; the box it answers is cleared", () => {
    const s = type(start(), ES);
    const go = SS.translateStart(s.st, s.f);
    expect(go.body).toEqual({ text: ES, register: "normal", context: { chat: "Priya Raman", from: "Priya Raman", last: PRIYA.last } });
    expect(go.st.phase).toBe("translating");
    expect(go.st.req).toBe(s.st.req + 1);
    expect(go.st.en).toBe("");
    expect(go.st.enSeq).toBe(s.st.enSeq + 1);
    expect(go.st.chatFor).toBe("Priya Raman");
  });

  test("with no chat open the request has no context and the English belongs to no chat", () => {
    const s = type(start(NOCHAT), ES);
    const go = SS.translateStart(s.st, s.f);
    expect(go.body.context).toBeUndefined();
    expect(go.st.chatFor).toBe("");
  });

  const refuse: [string, () => S][] = [
    ["an empty box", () => start()],
    ["a blank box", () => type(start(), "   ")],
    ["while sending", () => { const s = ready(); return { ...s, st: { ...s.st, phase: "sending" } }; }],
    ["while adjusting", () => { const s = ready(); return { ...s, st: { ...s.st, phase: "adjusting" } }; }],
    ["while dictation's last words are coming in", () => ({ ...type(start(), ES), st: { ...type(start(), ES).st, dictStopping: true } })],
  ];
  for (const [name, mk] of refuse) test(`nothing starts on ${name}`, () => { const s = mk(); expect(SS.translateStart(s.st, s.f)).toBeNull(); });

  test("the same text asked again while it is translating is not asked twice", () => {
    let s = type(start(), ES);
    s = applied(s, SS.translateStart(s.st, s.f).st);
    expect(SS.translateStart(s.st, s.f)).toBeNull();
  });

  const answers: [string, any, string, string][] = [
    ["English", { text: EN, language: "English", from: "target", lint: [] }, "ready", EN],
    ["a question", { question: "This Thursday or next week's?" }, "question", "This Thursday or next week's?"],
    ["an error", { error: "offline" }, "error", ""],
    ["nothing usable", {}, "error", ""],
    ["blank English", { text: "  " }, "error", ""],
  ];
  for (const [name, d, phase, en] of answers) {
    test(`the answer is ${name}`, () => {
      let s = type(start(), ES);
      s = applied(s, SS.translateStart(s.st, s.f).st);
      s = applied(s, SS.translateDone(s.st, s.f, d));
      expect(s.st.phase).toBe(phase);
      expect(s.f.en).toBe(en);
    });
  }
  test("a failed adjust keeps the English, so its notice stays in the footer", () => {
    let s = ready();
    s = applied(s, SS.adjustStart(s.st, s.f, "corto").st);
    s = applied(s, SS.adjustDone(s.st, s.f, { error: "failed" }).st);
    expect(s.f.en).toBe(EN);
    expect(SS.view(s.st, null).tag?.kind).toBe("error");
  });

  test("an answer for text that was changed since is dropped", () => {
    let s = type(start(), ES);
    s = applied(s, SS.translateStart(s.st, s.f).st);
    const changed = { ...s.f, es: ES + "!" };
    expect(SS.translateDone(s.st, changed, { text: EN, language: "English", from: "target" }).phase).toBe("idle");
  });

  test("findings that aren't {message} are dropped", () => {
    const s = ready(ES, EN, PRIYA, []);
    const t = SS.translateDone({ ...s.st, phase: "translating" }, s.f, { text: EN, language: "English", from: "target", lint: [{ level: "warning", message: "Stiff" }, { level: "x" }, null, { message: "" }] });
    expect(t.lint).toEqual([{ level: "warning", message: "Stiff" }]);
  });

  test("changing the register: asks again over a translation or one in flight, never on an empty box", () => {
    const r1 = SS.setRegister(ready().st, "formal", ready().f);
    expect(r1.st.register).toBe("formal");
    expect(r1.again).toBe(true);
    let s = type(start(), ES);
    s = applied(s, SS.translateStart(s.st, s.f).st);
    const r2 = SS.setRegister(s.st, "formal", s.f);
    expect(r2.again).toBe(true);
    expect(SS.translateStart(r2.st, s.f)).not.toBeNull(); // the text is no longer the one in flight
    const e = start();
    expect(SS.setRegister(e.st, "formal", e.f)).toEqual({ st: { ...e.st, register: "formal" }, again: false });
  });
});

// ---------------------------------------------------------------------------------------- out of date
describe("out of date after an edit", () => {
  type Row = [string, string, string, string];   // name, phase before, Spanish after, phase after
  const edits: Row[] = [
    ["ready, edited", "ready", ES + "!", "stale"],
    ["ready, same text (a space around it doesn't count)", "ready", ` ${ES} `, "ready"],
    ["stale, edited back", "stale", ES, "ready"],
    ["stale, edited again", "stale", ES + "!!", "stale"],
    ["draft, edited", "draft", ES + "!", "stale"],
    ["draft, same text", "draft", ES, "draft"],
    ["translating, edited (the answer in flight is dropped)", "translating", ES + "!", "idle"],
    ["translating, same text", "translating", ES, "translating"],
    ["adjusting, edited (the answer in flight is dropped)", "adjusting", ES + "!", "stale"],
    ["adjusting, same text", "adjusting", ES, "adjusting"],
    ["sent, any typing starts over", "sent", ES + "!", "idle"],
    ["left in Teams, any typing starts over", "leave", ES + "!", "idle"],
    ["question stays a question", "question", ES + "!", "question"],
    ["idle stays idle", "idle", ES + "!", "idle"],
  ];
  for (const [name, before, es, after] of edits) {
    test(name, () => {
      const s = ready();
      const st0 = { ...s.st, phase: before };
      const st1 = SS.typed(st0, { es, en: s.f.en });
      expect(st1.phase).toBe(after);
      // an answer in flight stops mattering only when it is dropped
      const dropped = ["translating", "adjusting"].includes(before) && after !== before;
      expect(st1.req).toBe(st0.req + (dropped ? 1 : 0));
    });
  }

  test("an empty English box has nothing to be out of date", () => {
    const s = ready();
    const st = SS.editedEnglish(s.st, "");
    expect(SS.typed(st, { es: ES + "!", en: "" }).phase).toBe("ready");
  });

  test("an edit clears the notice, the open adjust line and the Adjusted mark", () => {
    const s = ready();
    const st = { ...s.st, notice: { kind: "error", text: "x" }, adjustOpen: true, adjusted: true };
    const n = SS.typed(st, { es: ES, en: EN });
    expect([n.notice, n.adjustOpen, n.adjusted]).toEqual([null, false, false]);
  });

  test("while out of date Send is off, Translate is on, and the tag says so", () => {
    const s = type(ready(), ES + "!");
    expect(s.st.phase).toBe("stale");
    expect(canSend(s)).toBe(false);
    expect(SS.canTranslate(s.st, s.f)).toBe(true);
    expect(tagOf(s)).toBe("error: Translation out of date");
    expect(labels(s)).toEqual([]);
  });

  // Writing the English yourself, in an empty strip.
  function writeEnglish(s: S, en: string, target = "English"): S {
    const f = { ...s.f, en };
    return { st: SS.editedEnglish(s.st, en, f, target), f };
  }
  test("in an empty strip, what you type in the English box is the message: ready, for the chat open, in your target", () => {
    const s = writeEnglish(start(), "Running five minutes late, start without me.");
    expect(s.st.phase).toBe("ready");
    expect(s.st.chatFor).toBe("Priya Raman");
    expect([s.st.language, s.st.from]).toEqual(["English", "target"]);
    expect(canSend(s)).toBe(true);
    const go = SS.sendStart(s.st, s.f, false, "send");
    expect(go.msg).toEqual({ type: "send", text: "Running five minutes late, start without me.", mode: "send", chat: "Priya Raman" });
  });
  test("a message typed in the English box takes the target language's name", () => {
    expect(writeEnglish(start(), "Claro, já vou.", "Português").st.language).toBe("Português");
  });
  test("emptying it again, with the Spanish box empty, empties the strip", () => {
    const s = writeEnglish(writeEnglish(start(), "On my way"), "");
    expect(s.st.phase).toBe("idle");
    expect(s.st.chatFor).toBe("");
    expect(canSend(s)).toBe(false);
  });
  test("writing in the other box afterwards puts the typed English out of date", () => {
    const s = type(writeEnglish(start(), "On my way"), "Ya voy");
    expect(s.st.phase).toBe("stale");
    expect(canSend(s)).toBe(false);
  });
  test("with no chat open, the typed English can't be sent", () => {
    const s = writeEnglish(start(NOCHAT), "On my way");
    expect(s.st.phase).toBe("ready");
    expect(canSend(s)).toBe(false);
  });
  test("after a translation, emptying the English keeps it ready (the Spanish is still there)", () => {
    const s = ready();
    const f = { ...s.f, en: "" };
    expect(SS.editedEnglish(s.st, "", f, "English").phase).toBe("ready");
  });

  test("editing the English by hand keeps it ready and drops the voice findings", () => {
    const s = ready(ES, EN, PRIYA, [{ level: "warning", message: "Stiff" }]);
    expect(tagOf(s)).toBe("needs: Stiff");
    const st = SS.editedEnglish(s.st, "Could you check the budget by Thursday?");
    expect(st.phase).toBe("ready");
    expect(st.lint).toEqual([]);
    expect(SS.view(st, null).tag).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------- sending
describe("what a send leaves behind", () => {
  test("a send carries the text, the mode and the chat the strip showed", () => {
    const s = ready();
    const go = SS.sendStart(s.st, { es: ES, en: `  ${EN}\n` }, false, "leave");
    expect(go.msg).toEqual({ type: "send", text: EN, mode: "leave", chat: "Priya Raman" });
    expect(go.st.phase).toBe("sending");
    expect(SS.view(go.st, null).tag).toEqual({ kind: "working", text: "Putting in Teams…" });
    expect(SS.sendStart(s.st, s.f, true, "send").msg).toEqual({ type: "send", text: EN, mode: "send", chat: "Priya Raman", afterDraft: true });
    expect(SS.view(SS.sendStart(s.st, s.f, false, "send").st, null).tag).toEqual({ kind: "working", text: "Sending…" });
  });

  const refuse: [string, () => S][] = [
    ["no English", () => ({ ...ready(), f: { es: ES, en: "  " } })],
    ["Teams closed", () => withTeams(ready(), CLOSED)],
    ["no chat open", () => withTeams(ready(), NOCHAT)],
    ["Accessibility off", () => { const s = ready(); return { ...s, st: SS.shellAccess(s.st, { accessibility: false, microphone: "unknown" }).st }; }],
    ["a translation out of date", () => type(ready(), ES + "!")],
    ["a translation still coming", () => { let s = type(start(), ES); return applied(s, SS.translateStart(s.st, s.f).st); }],
    ["Teams' message box not found", () => withTeams(ready(), UNKNOWN)],
    ["two boxes in Teams and none with the cursor", () => withTeams(ready(), SEVERAL)],
    ["dictation's last words still coming in", () => { const s = ready(); return { ...s, st: { ...s.st, dictStopping: true } }; }],
  ];
  for (const [name, mk] of refuse) test(`Send is off with ${name}`, () => { const s = mk(); expect(canSend(s)).toBe(false); expect(SS.sendStart(s.st, s.f, false, "send")).toBeNull(); });

  test("Accessibility not asked yet (null) doesn't turn Send off", () => {
    const s = ready();
    expect(canSend({ ...s, st: SS.shellAccess(s.st, {}).st })).toBe(true);
  });

  test("success (the message showed in the chat): both boxes empty, 'Sent · time' in the footer, the next typing starts over", () => {
    const s = sendAnd(ready(), { ok: true });
    expect(s.st.phase).toBe("sent");
    expect([s.f.es, s.f.en]).toEqual(["", ""]);
    expect(SS.view(s.st, null).tag).toEqual({ kind: "done", text: "Sent · 9:41 AM", title: "Sent to Priya Raman at 9:41 AM" });
    expect(canSend(s)).toBe(false);
    expect(s.st.chatFor).toBe("");
    expect(SS.typed(s.st, { es: "h", en: "" }).phase).toBe("idle");
  });
  test("'Sent' fades after a few seconds, back to an empty strip; the fade does nothing once something else happened", () => {
    const s = sendAnd(ready(), { ok: true });
    expect(SS.fadeDone(s.st).phase).toBe("idle");
    const r = ready();
    expect(SS.fadeDone(r.st)).toBe(r.st);
  });

  test("success in leave mode says it was left, not sent", () => {
    const s = ready();
    const go = SS.sendStart(s.st, s.f, false, "leave");
    const done = SS.sendDone(go.st, { ok: true }, "9:41 AM");
    expect(done.phase).toBe("leave");
    expect(SS.view(done, null).tag).toEqual({ kind: "idle", text: "Left in Teams, not sent" });
  });

  test("an answer nobody asked for is ignored", () => {
    const s = ready();
    expect(SS.sendDone(s.st, { ok: true }, "9:41 AM")).toBe(s.st);
  });

  test("no answer in 20 s: back to ready with a notice, and only if still sending", () => {
    const s = ready();
    const go = SS.sendStart(s.st, s.f, false, "send");
    expect(SS.view(SS.sendTimeout(go.st), null).tag).toEqual({ kind: "error", text: "Teams didn't answer. Check the chat" });
    expect(SS.sendTimeout(s.st)).toBe(s.st);
  });

  // reason → [phase after, tag, buttons]. Each says what to do; the text always stays.
  const reasons: [string, string, string | null, string[]][] = [
    ["no-teams", "ready", "idle: Teams isn't open", ["Open Teams"]],
    ["no-chat", "ready", "idle: No chat open in Teams", []],
    ["not-front", "ready", "error: Teams didn't come forward", []],
    ["chat-changed", "ready", "error: Chat changed. Not sent", []],
    ["mismatch", "ready", "error: Teams changed it. Not sent", []],
    ["not-sent", "ready", "error: In Teams' box, not sent", []],
    ["not-posted", "ready", "error: Not in the chat. Check it", []],
    ["unconfirmed", "ready", "error: Not confirmed. Check the chat", []],
    ["cleared", "ready", "error: Teams cleared it. Not sent", []],
    ["no-paste", "ready", "error: Teams didn't take it. Not sent", []],
    ["not-own-server", "ready", "error: Not the app's own page. Not sent", []],
    ["something new", "ready", "error: Couldn't send", []],
    [undefined as any, "ready", "error: Couldn't send", []],
    ["draft", "draft", "needs: Teams has a draft", ["Add after draft", "Cancel"]],
  ];
  for (const [reason, phase, tag, buttons] of reasons) {
    test(`reason ${reason}`, () => {
      const s = sendAnd(ready(), { ok: false, reason });
      expect(s.st.phase).toBe(phase);
      expect(tagOf(s)).toBe(tag);
      expect(labels(s)).toEqual(buttons);
      expect(s.f.en).toBe(EN);   // nothing is lost
      expect(s.f.es).toBe(ES);
    });
  }

  test("a paste Teams didn't take leaves Send on, the English on screen, and the text marked as a possible leftover", () => {
    const s = sendAnd(ready(), { ok: false, reason: "no-paste" });
    expect(canSend(s)).toBe(true);
    // Teams may still take the paste late (the clipboard keeps the English a few seconds), so a
    // later send that finds this text in the box treats it as ours, never offers to add it again.
    expect(s.st.leftover).toBe(s.st.lastText);
  });

  test("which-box: an orange 'Click the box in Teams first', nothing left behind, Send on again", () => {
    const s = sendAnd(ready(), { ok: false, reason: "which-box" });
    expect(tagOf(s)).toBe("needs: Click the box in Teams first");
    expect(s.st.leftover).toBeNull();
    expect(canSend(s)).toBe(true);
  });

  test("the position: automatic until the shell says another, and an unknown value keeps the one before", () => {
    const s = ready();
    expect(s.st.layout).toBe("automatic");
    const left = SS.shellLayout(s.st, { value: "left" });
    expect(left.layout).toBe("left");
    expect(SS.shellLayout(left, { value: "sideways" }).layout).toBe("left");
    expect(SS.shellLayout(left, null).layout).toBe("left");
    expect(SS.LAYOUTS).toEqual(["automatic", "below", "above", "left", "right"]);
  });

  test("no-access turns the first-run cover on and nothing else", () => {
    const s = sendAnd(ready(), { ok: false, reason: "no-access" });
    expect(s.st.access.accessibility).toBe(false);
    expect(s.st.phase).toBe("ready");
    expect(s.st.notice).toBeNull();
    expect(canSend(s)).toBe(false);
  });

  test("an environment notice goes away when Teams says anything new; the others stay", () => {
    const a = sendAnd(ready(), { ok: false, reason: "no-teams" });
    expect(SS.shellTeams(a.st, PRIYA).notice).toBeNull();
    const b = sendAnd(ready(), { ok: false, reason: "not-front" });
    expect(SS.shellTeams(b.st, PRIYA).notice).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------- leftover
describe("the leftover after a send that left text in Teams' box", () => {
  test("not posted: the English stays in the box, with nothing left behind in Teams, and Send works again", () => {
    const s = sendAnd(ready(), { ok: false, reason: "not-posted" });
    expect(s.st.en).toBe(EN);
    expect(s.st.leftover).toBeNull();
    expect(canSend(s)).toBe(true);
  });
  for (const reason of ["mismatch", "not-sent"]) {
    test(`${reason}: the same text found as a "draft" is our own, never added a second time`, () => {
      let s = sendAnd(ready(), { ok: false, reason });
      expect(s.st.leftover).toBe(EN);
      s = sendAnd(s, { ok: false, reason: "draft" });
      expect(s.st.phase).toBe("ready");
      expect(tagOf(s)).toBe("error: Already in Teams. Not sent");
      expect(labels(s)).toEqual([]);
    });
    test(`${reason}: a different English after it is a draft like any other`, () => {
      let s = sendAnd(ready(), { ok: false, reason });
      s = { ...s, f: { ...s.f, en: "Could you check the budget by Thursday?" } };
      s = sendAnd(s, { ok: false, reason: "draft" });
      expect(s.st.phase).toBe("draft");
    });
  }

  test("a real draft (no leftover) offers Add after draft, which sends with afterDraft", () => {
    let s = sendAnd(ready(), { ok: false, reason: "draft" });
    expect(s.st.phase).toBe("draft");
    expect(tagOf(s)).toBe("needs: Teams has a draft");
    expect(labels(s)).toEqual(["Add after draft", "Cancel"]);
    expect(canSend(s, false)).toBe(false);   // plain Send does nothing while the question is open
    expect(canSend(s, true)).toBe(true);
    const go = SS.sendStart(s.st, s.f, true, "send");
    expect(go.msg.afterDraft).toBe(true);
    // after the draft it went: a success clears the leftover
    expect(SS.sendDone(go.st, { ok: true }, "9:41 AM").leftover).toBeNull();
  });

  test("Cancel on the draft question goes back to the translation, with Send on", () => {
    const s = sendAnd(ready(), { ok: false, reason: "draft" });
    const back = SS.cancelDraft(s.st);
    expect(back.phase).toBe("ready");
    expect(canSend({ ...s, st: back })).toBe(true);
  });

  test("a success clears an old leftover", () => {
    let s = sendAnd(ready(), { ok: false, reason: "not-sent" });
    s = sendAnd(s, { ok: true });
    expect(s.st.leftover).toBeNull();
  });

  test("a second failed try with the first one's leftover and new English records the new leftover", () => {
    let s = sendAnd(ready(), { ok: false, reason: "not-sent" });
    s = { ...s, f: { ...s.f, en: "Another version." } };
    s = sendAnd(s, { ok: false, reason: "mismatch" });
    expect(s.st.leftover).toBe("Another version.");
  });
});

// ---------------------------------------------------------------------------------------- the chat changes
describe("a translation remembers its chat", () => {
  test("a translation made for a chat remembers it", () => {
    expect(ready().st.chatFor).toBe("Priya Raman");
  });

  test("Teams moves to another chat while the English is ready: red tag and box, Send and Adjust off", () => {
    const s = withTeams(ready(), DANIEL);
    expect(SS.mismatch(s.st)).toBe(true);
    expect(tagOf(s)).toBe("error: Written for Priya Raman");
    expect(labels(s)).toEqual([]);
    expect(canSend(s)).toBe(false);
    expect(SS.canAdjust(s.st, s.f)).toBe(false);
    expect(SS.canTranslate(s.st, s.f)).toBe(true);   // ⏎ translates again, for the chat that is open now
    expect(SS.view(s.st, null).state).toBe("written");   // the red box, like an error
    expect(SS.dataTeams(s.st)).toBe("ok");   // "To" shows the new chat
  });

  test("going back to that chat gives Send back and the tag goes", () => {
    const s = withTeams(withTeams(ready(), DANIEL), PRIYA);
    expect(SS.mismatch(s.st)).toBe(false);
    expect(tagOf(s)).toBeNull();
    expect(canSend(s)).toBe(true);
    expect(SS.canAdjust(s.st, s.f)).toBe(true);
  });

  test("translating again takes the chat that is open now", () => {
    let s = withTeams(ready(), DANIEL);
    const go = SS.translateStart(s.st, s.f);
    s = applied(s, go.st);
    expect(go.body.context.chat).toBe("Daniel Okafor");
    s = applied(s, SS.translateDone(s.st, s.f, { text: "Thanks, see you then.", language: "English", from: "target" }));
    expect(s.st.chatFor).toBe("Daniel Okafor");
    expect(tagOf(s)).toBeNull();
    expect(canSend(s)).toBe(true);
  });

  test("the chat changes while it is still translating: the tag is there as soon as the English is", () => {
    let s = type(start(), ES);
    s = applied(s, SS.translateStart(s.st, s.f).st);
    s = withTeams(s, DANIEL);
    expect(tagOf(s)).toBeNull();   // nothing to be written for yet
    s = applied(s, SS.translateDone(s.st, s.f, { text: EN, language: "English", from: "target" }));
    expect(tagOf(s)).toBe("error: Written for Priya Raman");
    expect(canSend(s)).toBe(false);
  });

  const quiet: [string, TeamsCase][] = [
    ["the chat closes (the no-chat notice says it)", { teams: NOCHAT, tag: "idle: No chat open in Teams" }],
    ["Teams closes", { teams: CLOSED, tag: "idle: Teams isn't open" }],
  ];
  type TeamsCase = { teams: any; tag: string };
  for (const [name, c] of quiet) test(`${name}: no "written for" tag`, () => {
    const s = withTeams(ready(), c.teams);
    expect(SS.mismatch(s.st)).toBe(false);
    expect(tagOf(s)).toBe(c.tag);
    expect(canSend(s)).toBe(false);
  });

  test("a translation made with no chat open belongs to no chat: a chat that opens is not a mismatch", () => {
    const s = ready(ES, EN, NOCHAT);
    const t = withTeams(s, DANIEL);
    expect(t.st.chatFor).toBe("");
    expect(SS.mismatch(t.st)).toBe(false);
    expect(canSend(t)).toBe(true);
  });

  test("a chat that opens with the same name is the same chat", () => {
    expect(canSend(withTeams(ready(), { ...PRIYA, draft: true }))).toBe(true);
  });

  test("a draft question for another chat shows the chat tag and offers no Add", () => {
    const s = sendAnd(ready(), { ok: false, reason: "draft" });
    const t = withTeams(s, DANIEL);
    expect(tagOf(t)).toBe("error: Written for Priya Raman");
    expect(labels(t)).toEqual([]);
    expect(canSend(t, true)).toBe(false);
    expect(tagOf(withTeams(t, PRIYA))).toBe("needs: Teams has a draft");
  });

  test("out of date, sending, adjusting, question and error come first", () => {
    const base = withTeams(ready(), DANIEL);
    const phases: [string, string][] = [["stale", "error: Translation out of date"], ["sending", "working: Sending…"], ["adjusting", "working: Adjusting…"], ["question", "asks: Asks you"]];
    for (const [phase, tag] of phases) expect(tagOf({ ...base, st: { ...base.st, phase } })).toBe(tag);
    expect(tagOf({ ...base, st: { ...base.st, phase: "error", err: { kind: "failed", what: "translate" } } })).toBe("error: Couldn't translate");
  });

  test("it beats a send notice that is still up", () => {
    const s = sendAnd(ready(), { ok: false, reason: "not-front" });
    expect(tagOf(s)).toBe("error: Teams didn't come forward");
    expect(tagOf(withTeams(s, DANIEL))).toBe("error: Written for Priya Raman");
    expect(tagOf(withTeams(s, PRIYA))).toBe("error: Teams didn't come forward");
  });

  test("a long chat name is carried whole (the page shortens it, its title holds it)", () => {
    const long = "Castellanos Moreira, Valentina Sofía";
    expect(tagOf(withTeams(ready(ES, EN, { ...PRIYA, chat: long }), DANIEL))).toBe(`error: Written for ${long}`);
  });

  test("sending clears it for good: the next translation starts from the chat it is made in", () => {
    const s = sendAnd(ready(), { ok: true });
    expect(s.st.chatFor).toBe("");
  });

  test("Esc forgets the chat", () => {
    const s = ready();
    expect(SS.clearAll(s.st).st.chatFor).toBe("");
  });

  test("an adjust started before the chat changed answers into the tag", () => {
    let s = ready();
    const go = SS.adjustStart(s.st, s.f, "más corto");
    s = applied(s, go.st);
    s = withTeams(s, DANIEL);
    const r = SS.adjustDone(s.st, s.f, { text: "Can you check the budget before Thursday?", language: "English", from: "target" });
    expect(tagOf({ ...s, st: r.st })).toBe("error: Written for Priya Raman");
    expect(r.st.chatFor).toBe("Priya Raman");
  });
});

// ---------------------------------------------------------------------------------------- adjusting
describe("adjusting", () => {
  test("a note starts a request with the English on show; Undo brings the earlier one back", () => {
    let s = ready();
    const go = SS.adjustStart(s.st, s.f, "  más corto ");
    expect(go.body).toEqual({ text: ES, current: EN, note: "más corto", register: "normal", context: { chat: "Priya Raman", from: "Priya Raman", last: PRIYA.last }, language: "English" });
    expect(go.st.phase).toBe("adjusting");
    expect(tagOf({ ...s, st: go.st })).toBe("working: Adjusting…");
    s = applied(s, go.st);
    const r = SS.adjustDone(s.st, s.f, { text: "Can you check the budget before Thursday?", language: "English", from: "target" });
    expect(r.focus).toBe(true);
    s = applied(s, r.st);
    expect(s.st.phase).toBe("ready");
    expect(s.f.en).toBe("Can you check the budget before Thursday?");
    expect(tagOf(s)).toBe("idle: Adjusted");
    expect(labels(s)).toEqual(["Undo"]);
    s = applied(s, SS.undo(s.st));
    expect(s.f.en).toBe(EN);
    expect(s.st.adjusted).toBe(false);
    expect(tagOf(s)).toBeNull();
  });

  const nope: [string, () => [St, Boxes, string]][] = [
    ["an empty note", () => { const s = ready(); return [s.st, s.f, "  "]; }],
    ["nothing to adjust", () => { const s = ready(); return [s.st, { ...s.f, en: "" }, "corto"]; }],
    ["out of date", () => { const s = type(ready(), ES + "!"); return [s.st, s.f, "corto"]; }],
    ["another chat open", () => { const s = withTeams(ready(), DANIEL); return [s.st, s.f, "corto"]; }],
  ];
  for (const [name, mk] of nope) test(`no request on ${name}`, () => { const [st, f, note] = mk(); expect(SS.adjustStart(st, f, note)).toBeNull(); });

  test("an answer for Spanish changed since leaves the translation out of date", () => {
    const s = ready();
    const go = SS.adjustStart(s.st, s.f, "corto");
    expect(SS.adjustDone(go.st, { ...s.f, es: ES + "!" }, { text: "x" }).st.phase).toBe("stale");
  });

  const replies: [string, any, string | null, string[]][] = [
    ["a question stays over the English", { question: "Shorter how?" }, "asks: Shorter how?", []],
    ["an error", { error: "failed" }, "error: Couldn't adjust", ["Try again"]],
    ["offline", { error: "offline" }, "error: Can't reach Claude", ["Try again"]],
    ["not signed in", { error: "login" }, "idle: Sign in to Claude Code", ["Try again"]],
    ["Claude Code missing", { error: "missing" }, "idle: Install Claude Code", ["Try again"]],
    ["needs an update", { error: "update" }, "idle: Claude Code needs an update", ["Try again"]],
    ["the plan limit", { error: "limit" }, "idle: Plan limit reached", []],
    ["no guide", { error: "guide" }, "idle: Voice guide not set", ["Open guide settings"]],
  ];
  for (const [name, d, tag, buttons] of replies) {
    test(`the reply is ${name}: the English stays`, () => {
      let s = ready();
      s = applied(s, SS.adjustStart(s.st, s.f, "corto").st);
      const r = SS.adjustDone(s.st, s.f, d);
      expect(r.st.phase).toBe("ready");
      expect(r.st.en).toBe(EN);
      expect(r.st.enSeq).toBe(s.st.enSeq);   // no box is rewritten
      expect(tagOf({ ...s, st: r.st })).toBe(tag);
      expect(labels({ ...s, st: r.st })).toEqual(buttons);
    });
  }

  test("Try again on an adjust error clears the notice (the page then asks again with the same note)", () => {
    let s = ready();
    s = applied(s, SS.adjustStart(s.st, s.f, "corto").st);
    s = applied(s, SS.adjustDone(s.st, s.f, { error: "failed" }).st);
    expect(s.st.lastNote).toBe("corto");
    expect(SS.clearNotice(s.st).notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------- notices
describe("the notices and their buttons", () => {
  const srv = (translator: any) => ({ translator });
  type Row = [string, () => S, any, string | null, string[], string?];   // name, state, server, tag, buttons, data-state
  const rows: Row[] = [
    ["nothing to say", () => start(), null, null, []],
    ["Teams closed", () => start(CLOSED), null, "idle: Teams isn't open", ["Open Teams"]],
    ["no chat open", () => start(NOCHAT), null, "idle: No chat open in Teams", []],
    ["Teams' message box not found", () => start(UNKNOWN), null, "error: Can't find Teams' message box", []],
    ["Teams closed beats the box not being found", () => start({ ...UNKNOWN, open: false }), null, "idle: Teams isn't open", ["Open Teams"]],
    ["no chat, and the box not found", () => start({ ...UNKNOWN, chat: null }), null, "error: Can't find Teams' message box", []],
    ["the shell hasn't spoken yet", () => ({ st: SS.create(), f: { es: "", en: "" } }), null, null, []],
    ["no voice guide, nothing written", () => start(), srv({ guide: "missing" }), "idle: Voice guide not set", ["Open guide settings"], "noguide"],
    ["the guide is fine", () => start(), srv({ guide: "ok" }), null, []],
    ["translator starting", () => { let s = type(start(), ES); return applied(s, SS.translateStart(s.st, s.f).st); }, srv({ status: "starting" }), null, [], "starting"],
    ["translating", () => { let s = type(start(), ES); return applied(s, SS.translateStart(s.st, s.f).st); }, srv({ status: "ready" }), null, [], "translating"],
    ["ready", () => ready(), null, null, [], "ready"],
    ["ready, with Teams closed", () => withTeams(ready(), CLOSED), null, "idle: Teams isn't open", ["Open Teams"]],
    ["ready, with no chat", () => withTeams(ready(), NOCHAT), null, "idle: No chat open in Teams", []],
    ["ready, the box not found", () => withTeams(ready(), UNKNOWN), null, "error: Can't find Teams' message box", []],
    ["ready, two boxes and none with the cursor", () => withTeams(ready(), SEVERAL), null, "needs: Click the box in Teams first", []],
    ["ready with a voice finding", () => ready(ES, EN, PRIYA, [{ level: "warning", message: "Stiff" }, { level: "warning", message: "Long" }]), null, "needs: Stiff", ["Fix it"]],
    ["ready, the box not found, beats a voice finding", () => withTeams(ready(ES, EN, PRIYA, [{ level: "warning", message: "Stiff" }]), UNKNOWN), null, "error: Can't find Teams' message box", []],
    ["question", () => { const s = ready(); return applied(s, SS.translateDone({ ...s.st, phase: "translating" }, s.f, { question: "Which one?" })); }, null, "asks: Asks you", [], "question"],
    ["error: offline", () => errorState("offline"), null, "error: Can't reach Claude", ["Try again"], "error"],
    ["error: failed", () => errorState("failed"), null, "error: Couldn't translate", ["Try again"], "error"],
    ["error: anything else", () => errorState("weird"), null, "error: Couldn't translate", ["Try again"], "error"],
    ["error: not signed in", () => errorState("login"), null, "idle: Sign in to Claude Code", ["Try again"], "login"],
    ["error: Claude Code missing", () => errorState("missing"), null, "idle: Install Claude Code", ["Try again"], "login"],
    ["error: needs an update", () => errorState("update"), null, "idle: Claude Code needs an update", ["Try again"], "update"],
    ["error: plan limit", () => errorState("limit"), null, "idle: Plan limit reached", [], "limit"],
    ["error: no guide", () => errorState("guide"), null, "idle: Voice guide not set", ["Open guide settings"], "noguide"],
  ];
  function errorState(kind: string): S {
    let s = type(start(), kind.toUpperCase());
    s = applied(s, SS.translateStart(s.st, s.f).st);
    return applied(s, SS.translateDone(s.st, s.f, { error: kind }));
  }
  for (const [name, mk, server, tag, buttons, dataState] of rows) {
    test(name, () => {
      const s = mk();
      expect(tagOf(s, server)).toBe(tag);
      expect(labels(s, server)).toEqual(buttons);
      if (dataState) expect(view(s, server).state).toBe(dataState);
    });
  }

  test("the plan limit says until when, if it is known: the time today, the day and time after", () => {
    // Two hours from now can be tomorrow late in the day, so the day shows when it isn't today.
    const at = new Date(Date.now() + 2 * 3600_000);
    const today = at.toDateString() === new Date().toDateString();
    expect(SS.errorView("limit", at.toISOString(), "translate").tag.text).toMatch(today ? /^Plan limit reached until \d{1,2}:\d{2}\s?[AP]M$/ : /^Plan limit reached until [A-Z][a-z]{2} \d{1,2}:\d{2}\s?[AP]M$/);
    const later = new Date(Date.now() + 3 * 86400_000).toISOString();
    expect(SS.errorView("limit", later, "translate").tag.text).toMatch(/^Plan limit reached until [A-Z][a-z]{2} \d{1,2}:\d{2}\s?[AP]M$/);
    expect(SS.errorView("limit", "not a date", "translate").tag.text).toBe("Plan limit reached");
  });

  test("the retry button depends on what failed", () => {
    expect(SS.errorView("failed", undefined, "translate").actions).toEqual([{ act: "retry", label: "Try again" }]);
    expect(SS.errorView("failed", undefined, "adjust").actions).toEqual([{ act: "retry-adjust", label: "Try again" }]);
    expect(SS.errorView("login", undefined, "adjust").actions).toEqual([{ act: "retry-adjust", label: "Try again" }]);
  });

  test("the voice-finding tag holds all the findings in its title", () => {
    const s = ready(ES, EN, PRIYA, [{ level: "warning", message: "Stiff" }, { level: "warning", message: "Long" }]);
    expect(view(s).tag.title).toBe("Stiff\nLong");
  });

  test("an error notice colors the English side red", () => {
    const s = sendAnd(ready(), { ok: false, reason: "no-paste" });
    expect(view(s).state).toBe("error");
    expect(view(sendAnd(ready(), { ok: false, reason: "no-chat" })).state).toBe("ready");   // a gray notice leaves the color alone
  });

  test("data-teams follows what the shell said", () => {
    expect(SS.dataTeams(SS.create())).toBe("unknown");
    expect(SS.dataTeams(start(CLOSED).st)).toBe("closed");
    expect(SS.dataTeams(start(NOCHAT).st)).toBe("nochat");
    expect(SS.dataTeams(start(PRIYA).st)).toBe("ok");
    expect(SS.dataTeams(start(UNKNOWN).st)).toBe("unknown");
    expect(SS.dataTeams(start({ ...PRIYA, shape: undefined }).st)).toBe("ok");   // an older shell says nothing about the shape
    expect(SS.dataTeams(SS.shellTeams(SS.create(), "nonsense"))).toBe("unknown");
  });

  test("Teams' message box not found turns Send off and the tag explains it; found again, Send is back", () => {
    const s = withTeams(ready(), UNKNOWN);
    expect(canSend(s)).toBe(false);
    expect(canSend(withTeams(s, PRIYA))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------- Esc
describe("Esc clears everything", () => {
  test("both boxes, the notice, the error, the mark and any answer in flight", () => {
    let s = ready();
    s = { ...s, st: { ...s.st, notice: { kind: "error", text: "x" }, adjusted: true, adjustOpen: true } };
    const r = SS.clearAll(s.st);
    s = applied(s, r.st);
    expect([s.f.es, s.f.en]).toEqual(["", ""]);
    expect([s.st.phase, s.st.notice, s.st.err, s.st.adjusted, s.st.adjustOpen]).toEqual(["idle", null, null, false, false]);
    expect(s.st.req).toBe(r.st.req);
    expect(r.st.req).toBeGreaterThan(ready().st.req);
    expect(r.stopDictation).toBe(false);
  });
  test("it stops the dictation, if one is listening", () => {
    let s = start();
    s = applied(s, SS.dictStart(s.st, s.f).st);
    const r = SS.clearAll(s.st);
    expect(r.stopDictation).toBe(true);
    expect(r.st.dict).toBe("off");
  });
});

// ---------------------------------------------------------------------------------------- dictation
describe("dictation's states", () => {
  const listening = () => { const s = start(); const go = SS.dictStart(s.st, s.f); return { s: applied(s, go.st), go }; };

  test("start says so to the shell and listens", () => {
    const { s, go } = listening();
    expect(go.msg).toEqual({ type: "dictation", action: "start", locale: "es-MX" });
    expect(s.st.dict).toBe("on");
    expect(SS.dictLabel(s.st)).toEqual({ kind: "listening" });
  });

  const nope: [string, () => S][] = [
    ["listening already", () => listening().s],
    ["denied", () => ({ ...start(), st: SS.shellAccess(start().st, { accessibility: true, microphone: "denied" }).st })],
    ["the last words still coming in", () => { const s = start(); return { ...s, st: { ...s.st, dictStopping: true } }; }],
    ["a translation in flight", () => { let s = type(start(), ES); return applied(s, SS.translateStart(s.st, s.f).st); }],
    ["sending", () => { const s = ready(); return { ...s, st: { ...s.st, phase: "sending" } }; }],
    ["adjusting", () => { const s = ready(); return { ...s, st: { ...s.st, phase: "adjusting" } }; }],
  ];
  for (const [name, mk] of nope) test(`it doesn't start while ${name}`, () => { const s = mk(); expect(SS.dictStart(s.st, s.f)).toBeNull(); });

  test("the words replace what dictation added, after what was already there", () => {
    let s = type(start(), "Hola, necesito");
    s = applied(s, SS.dictStart(s.st, s.f).st);
    for (const [say, want] of [["el", "Hola, necesito el"], ["el reporte", "Hola, necesito el reporte"], ["el reporte hoy", "Hola, necesito el reporte hoy"]]) {
      const r = SS.onDictation(s.st, { state: "on", text: say }, s.f);
      s = applied(s, r.st);
      expect(s.f.es).toBe(want);
      expect(r.done).toBe(false);
    }
  });

  test("words over a translation make it out of date", () => {
    let s = ready();
    s = applied(s, SS.dictStart(s.st, s.f).st);
    s = applied(s, SS.onDictation(s.st, { state: "on", text: "otra cosa" }, s.f).st);
    expect(s.st.phase).toBe("stale");
  });

  test("preparing shows the progress; listening starts by itself when it's there", () => {
    let s = start();
    s = applied(s, SS.dictStart(s.st, s.f).st);
    s = applied(s, SS.onDictation(s.st, { state: "preparing" }, s.f).st);
    expect(SS.dictLabel(s.st)).toEqual({ kind: "prep", text: "Getting dictation ready…" });
    s = applied(s, SS.onDictation(s.st, { state: "preparing", progress: 0.55 }, s.f).st);
    expect(SS.dictLabel(s.st)).toEqual({ kind: "prep", text: "Getting dictation ready… 55%" });
    s = applied(s, SS.onDictation(s.st, { state: "preparing" }, s.f).st);   // no number: keeps the last one
    expect(SS.dictLabel(s.st)?.text).toContain("55%");
    s = applied(s, SS.onDictation(s.st, { state: "on", text: "" }, s.f).st);
    expect(SS.dictLabel(s.st)).toEqual({ kind: "listening" });
  });

  test("preparing, when it isn't listening, says nothing", () => {
    const s = start();
    expect(SS.onDictation(s.st, { state: "preparing", progress: 0.5 }, s.f).st).toBe(s.st);
  });

  test("the shell starting on its own (the shortcut) listens, after what's in the box", () => {
    let s = type(start(), "Hola");
    s = applied(s, SS.onDictation(s.st, { state: "on", text: "buenas" }, s.f).st);
    expect(s.st.dict).toBe("on");
    expect(s.f.es).toBe("Hola buenas");
  });

  test("stop: listening ends at once, the late words still land, the 'off' finishes it", () => {
    let { s } = listening();
    s = applied(s, SS.onDictation(s.st, { state: "on", text: "el reporte" }, s.f).st);
    const stop = SS.dictStop(s.st);
    expect(stop.msg).toEqual({ type: "dictation", action: "stop" });
    s = applied(s, stop.st);
    expect(s.st.dict).toBe("off");
    expect(s.st.dictStopping).toBe(true);
    expect(SS.canTranslate(s.st, s.f)).toBe(false);   // not until the last words are in
    expect(SS.dictLabel(s.st)).toBeNull();
    const late = SS.onDictation(s.st, { state: "on", text: "el reporte de hoy" }, s.f);   // a late result
    s = applied(s, late.st);
    expect(s.f.es).toBe("el reporte de hoy");
    expect(late.done).toBe(false);
    const off = SS.onDictation(s.st, { state: "off", text: "el reporte de hoy." }, s.f);
    expect(off.done).toBe(true);
    s = applied(s, off.st);
    expect(s.f.es).toBe("el reporte de hoy.");
    s = applied(s, SS.dictFinish(s.st));
    expect(s.st.dictStopping).toBe(false);
    expect(SS.canTranslate(s.st, s.f)).toBe(true);
  });

  test("stop when it wasn't listening has nothing to wait for", () => {
    expect(SS.dictStop(start().st)).toBeNull();
  });

  test("words that arrive after it is all over are ignored", () => {
    const s = type(start(), "Hola");
    expect(SS.onDictation(s.st, { state: "off", text: "tarde" }, s.f).st.esSeq).toBe(s.st.esSeq);
  });

  test("a 'denied' from the shell turns the mic off, with its words and button", () => {
    let { s } = listening();
    s = applied(s, SS.onDictation(s.st, { state: "denied" }, s.f).st);
    expect(s.st.dict).toBe("denied");
    expect(SS.dictLabel(s.st)).toEqual({ kind: "denied" });
  });

  test("'unavailable' says so and the mic stays off", () => {
    let { s } = listening();
    s = applied(s, SS.onDictation(s.st, { state: "unavailable" }, s.f).st);
    expect(s.st.dict).toBe("off");
    expect(SS.dictLabel(s.st)).toEqual({ kind: "note", text: "Dictation isn't available on this Mac" });
    expect(SS.dictStart(s.st, s.f)).not.toBeNull();   // it may try again
  });

  test("'unavailable' names the dictation language when the page gave it", () => {
    let s = start();
    s = applied(s, SS.dictStart(s.st, s.f, "pt-BR", "Português (Brasil)").st);
    s = applied(s, SS.onDictation(s.st, { state: "unavailable" }, s.f).st);
    expect(SS.dictLabel(s.st)).toEqual({ kind: "note", text: "Dictation in Português (Brasil) isn't available on this Mac" });
  });

  test("the microphone denied in the system ends a dictation and blocks the next; allowed again, it is off", () => {
    let { s } = listening();
    const r = SS.shellAccess(s.st, { accessibility: true, microphone: "denied" });
    expect(r.stopDictation).toBe(true);
    expect(r.st.dict).toBe("denied");
    expect(SS.dictStart(r.st, s.f)).toBeNull();
    const back = SS.shellAccess(r.st, { accessibility: true, microphone: "granted" });
    expect(back.st.dict).toBe("off");
    expect(back.stopDictation).toBe(false);
    expect(SS.shellAccess(start().st, { accessibility: true, microphone: "denied" }).stopDictation).toBe(false);   // nothing was listening
  });

  test("denied while the last words were coming in drops the wait", () => {
    let { s } = listening();
    s = applied(s, SS.dictStop(s.st).st);
    const r = SS.shellAccess(s.st, { accessibility: true, microphone: "denied" });
    expect(r.st.dictStopping).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------- the shell
describe("what the shell says", () => {
  test("access: Accessibility true, false or not known yet", () => {
    const base = SS.create();
    expect(SS.shellAccess(base, { accessibility: false, microphone: "granted" }).st.access).toEqual({ accessibility: false, microphone: "granted" });
    expect(SS.shellAccess(base, { accessibility: "yes" }).st.access).toEqual({ accessibility: null, microphone: "unknown" });
    expect(SS.shellAccess(base, null).st.access).toEqual({ accessibility: null, microphone: "unknown" });
  });
  test("teams: an object is kept, anything else means unknown", () => {
    expect(SS.shellTeams(SS.create(), PRIYA).teams).toEqual(PRIYA);
    expect(SS.shellTeams(SS.create(), null).teams).toBeNull();
    expect(SS.shellTeams(SS.create(), "x").teams).toBeNull();
  });
  test("a transition never changes the state it was given", () => {
    const s = ready();
    const frozen = JSON.stringify(s.st);
    SS.typed(s.st, { es: "x", en: "y" });
    SS.sendStart(s.st, s.f, false, "send");
    SS.clearAll(s.st);
    SS.shellTeams(s.st, DANIEL);
    SS.setRegister(s.st, "formal", s.f);
    SS.adjustStart(s.st, s.f, "corto");
    expect(JSON.stringify(s.st)).toBe(frozen);
  });
});

// ---------------------------------------------------------------------------------------- the reply's language
describe("the language a translation is in", () => {
  const PT = "Sim, vou revisar hoje e te mando comentários amanhã.";
  // Translate with Auto on or off, and get back text in `language`, chosen `from` the chat or the target.
  function inLang(language: string, from: string, auto: boolean, teams: any = PRIYA): S {
    let s = type(start(teams), ES);
    const go = SS.translateStart(s.st, s.f, { auto });
    s = applied(s, go.st);
    return applied(s, SS.translateDone(s.st, s.f, { text: language === "English" ? EN : PT, language, from, lint: [] }));
  }

  test("the state keeps the translation's language and where it came from", () => {
    const s = inLang("Português", "chat", true);
    expect(s.st.language).toBe("Português");
    expect(s.st.from).toBe("chat");
    expect(s.st.langAuto).toBe(true);
    expect(s.st.langWho).toBe("Priya Raman");
    expect(s.f.en).toBe(PT);
    // Anything but "chat" reads as the target.
    expect(inLang("English", "x", true).st.from).toBe("target");
  });

  test("a request with no one-time target carries no target; the setting goes with the server's settings", () => {
    const s = type(start(), ES);
    expect("target" in SS.translateStart(s.st, s.f, { auto: true }).body).toBe(false);
    expect("target" in SS.translateStart(s.st, s.f).body).toBe(false);
  });

  test("a one-time target goes in the request and turns Auto off for this translation", () => {
    const s = inLang("Português", "chat", true);
    expect(SS.canRetarget(s.st, s.f, "English")).toBe(true);
    const go = SS.translateStart(s.st, s.f, { auto: true, target: "English" });
    expect(go.body).toEqual({ text: ES, register: "normal", context: { chat: "Priya Raman", from: "Priya Raman", last: PRIYA.last }, target: "English" });
    expect(go.st.langAuto).toBe(false);
    expect(go.st.language).toBe("");
    let t = applied(s, go.st);
    t = applied(t, SS.translateDone(t.st, t.f, { text: EN, language: "English", from: "target", lint: [] }));
    expect(SS.langView(t.st, "English")).toEqual({ auto: false, name: "English", title: "Your target language.", other: false });
    expect(SS.canRetarget(t.st, t.f, "English")).toBe(false);
  });

  const views: [string, () => S, string, any][] = [
    ["Auto took the chat's language", () => inLang("Português", "chat", true), "English",
      { auto: true, name: "Português", title: "The language of Priya Raman's last message. Click to send this one in English.", other: true }],
    ["Auto took the chat's language, which is the target", () => inLang("English", "chat", true), "English",
      { auto: true, name: "English", title: "The language of Priya Raman's last message.", other: false }],
    ["Auto couldn't tell", () => inLang("English", "target", true), "English",
      { auto: true, name: "English", title: "The chat has no clear language, so your target.", other: false }],
    ["Auto off", () => inLang("English", "target", false), "English",
      { auto: false, name: "English", title: "Your target language.", other: false }],
    ["Auto off, and the target changed since", () => inLang("English", "target", false), "Português",
      { auto: false, name: "English", title: "Click to send this one in Português.", other: true }],
    ["the chat's language with no author known", () => inLang("Português", "chat", true, { ...PRIYA, from: null }), "English",
      { auto: true, name: "Português", title: "The language of the other person's last message. Click to send this one in English.", other: true }],
  ];
  for (const [name, mk, target, want] of views) test(`the language button: ${name}`, () => expect(SS.langView(mk().st, target)).toEqual(want));

  const hidden: [string, () => S][] = [
    ["nothing translated yet", () => start()],
    ["translating", () => { const s = type(start(), ES); return applied(s, SS.translateStart(s.st, s.f, { auto: true }).st); }],
    ["a question", () => { const s = type(start(), ES); const go = SS.translateStart(s.st, s.f); const t = applied(s, go.st); return applied(t, SS.translateDone(t.st, t.f, { question: "Which one?" })); }],
    ["a reply with no language", () => { const s = type(start(), ES); const t = applied(s, SS.translateStart(s.st, s.f).st); return applied(t, SS.translateDone(t.st, t.f, { text: EN })); }],
    ["after Esc", () => { const s = inLang("Português", "chat", true); return applied(s, SS.clearAll(s.st).st); }],
    ["after a send", () => sendAnd(inLang("Português", "chat", true), { ok: true })],
  ];
  for (const [name, mk] of hidden) test(`no language button on ${name}`, () => expect(SS.langView(mk().st, "English")).toBeNull());

  test("it stays while the English is out of date, adjusting or sending, but only a ready one switches", () => {
    let s = inLang("Português", "chat", true);
    const stale = type(s, ES + "!");
    expect(SS.langView(stale.st, "English")?.name).toBe("Português");
    expect(SS.canRetarget(stale.st, stale.f, "English")).toBe(false);
    const adj = applied(s, SS.adjustStart(s.st, s.f, "corto").st);
    expect(SS.langView(adj.st, "English")?.name).toBe("Português");
    expect(SS.canRetarget(adj.st, adj.f, "English")).toBe(false);
    const sending = applied(s, SS.sendStart(s.st, s.f, false, "send").st);
    expect(SS.langView(sending.st, "English")?.name).toBe("Português");
    expect(SS.canRetarget(sending.st, sending.f, "English")).toBe(false);
    expect(SS.canRetarget(s.st, s.f, "")).toBe(false);
  });

  test("an adjust sends the current text and its language, and keeps how the language was chosen", () => {
    let s = inLang("Português", "chat", true);
    const go = SS.adjustStart(s.st, s.f, "más corto", "English");
    expect(go.body.current).toBe(PT);
    expect(go.body.language).toBe("Português");
    expect("english" in go.body).toBe(false);
    s = applied(s, go.st);
    s = applied(s, SS.adjustDone(s.st, s.f, { text: "Sim, reviso hoje.", language: "Português", from: "target", lint: [] }).st);
    expect(s.f.en).toBe("Sim, reviso hoje.");
    expect(SS.langView(s.st, "English")).toEqual({ auto: true, name: "Português", title: "The language of Priya Raman's last message. Click to send this one in English.", other: true });
    // A reply in another language than asked is named as it is, a plain target.
    const t = applied(s, SS.adjustStart(s.st, s.f, "corto", "English").st);
    const u = applied(t, SS.adjustDone(t.st, t.f, { text: EN, language: "English", from: "target", lint: [] }).st);
    expect(SS.langView(u.st, "English")).toEqual({ auto: false, name: "English", title: "Your target language.", other: false });
  });

  test("an adjust on a state with no language sends the target's", () => {
    let s = type(start(), ES);
    s = applied(s, SS.translateStart(s.st, s.f).st);
    s = applied(s, SS.translateDone(s.st, s.f, { text: EN }));
    expect(SS.adjustStart(s.st, s.f, "corto", "Português").body.language).toBe("Português");
    expect(SS.adjustStart(s.st, s.f, "corto").body.language).toBe("English");
  });
});

describe("dictation's language", () => {
  test("the start message carries the settings' locale, es-MX when there is none", () => {
    const s = start();
    expect(SS.dictStart(s.st, s.f, "pt-BR").msg).toEqual({ type: "dictation", action: "start", locale: "pt-BR" });
    expect(SS.dictStart(s.st, s.f, "").msg.locale).toBe("es-MX");
    expect(SS.dictStart(s.st, s.f, null).msg.locale).toBe("es-MX");
  });
});

describe("undo and the one-time target keep the language right", () => {
  const PT = "Sim, vou revisar hoje e te mando comentários amanhã.";
  function inLang(language: string, from: string, auto: boolean): S {
    let s = type(start(PRIYA), ES);
    s = applied(s, SS.translateStart(s.st, s.f, { auto }).st);
    return applied(s, SS.translateDone(s.st, s.f, { text: language === "English" ? EN : PT, language, from, lint: [] }));
  }

  test("undo after an adjust that changed the language brings the language back with the text", () => {
    let s = inLang("English", "target", false);
    s = applied(s, SS.adjustStart(s.st, s.f, "en francés", "English").st);
    s = applied(s, SS.adjustDone(s.st, s.f, { text: "Pouvez-vous regarder le budget avant jeudi ?", language: "Français", from: "target", lint: [] }).st);
    expect(s.st.language).toBe("Français");
    s = applied(s, SS.undo(s.st));
    expect(s.f.en).toBe(EN);
    expect(s.st.language).toBe("English");
    expect(SS.langView(s.st, "English").other).toBe(false);
    // The next adjust asks in the language on show again.
    expect(SS.adjustStart(s.st, s.f, "corto", "English").body.language).toBe("English");
  });

  test("undo after an adjust over Auto keeps how the language was chosen", () => {
    let s = inLang("Português", "chat", true);
    s = applied(s, SS.adjustStart(s.st, s.f, "in English", "English").st);
    s = applied(s, SS.adjustDone(s.st, s.f, { text: EN, language: "English", from: "target", lint: [] }).st);
    s = applied(s, SS.undo(s.st));
    expect([s.st.language, s.st.from, s.st.langAuto]).toEqual(["Português", "chat", true]);
  });

  test("the one-time target holds through a register switch and a retry, and not for new text", () => {
    let s = inLang("Português", "chat", true);
    const go = SS.translateStart(s.st, s.f, { auto: true, target: "English" });
    s = applied(s, go.st);
    s = applied(s, SS.translateDone(s.st, s.f, { text: EN, language: "English", from: "target", lint: [] }));
    // Formal: the same Spanish goes again, still in English.
    const r = SS.setRegister(s.st, "formal", s.f);
    expect(r.again).toBe(true);
    s = applied(s, r.st);
    const again = SS.translateStart(s.st, s.f, { auto: true });
    expect(again.body.target).toBe("English");
    expect(again.st.langAuto).toBe(false);
    s = applied(s, again.st);
    s = applied(s, SS.translateDone(s.st, s.f, { text: EN, language: "English", from: "target", lint: [] }));
    // New Spanish: Auto again.
    s = type(s, "Otra cosa: ¿nos vemos mañana?");
    const fresh = SS.translateStart(s.st, s.f, { auto: true });
    expect("target" in fresh.body).toBe(false);
    expect(fresh.st.langAuto).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------- this Mac's Translation (0.9.0)
describe("translating on this Mac", () => {
  // A translation whose reply is `d` (with the text EN unless d says otherwise).
  function replied(d: any, teams: any = PRIYA): S {
    let s = type(start(teams), ES);
    s = applied(s, SS.translateStart(s.st, s.f).st);
    return applied(s, SS.translateDone(s.st, s.f, { text: EN, language: "English", from: "target", lint: [], ...d }));
  }
  const srvOf = (model: string, translator: any = { status: "ready" }) => ({ translator: { model, ...translator }, settings: { model } });

  type Engine = [string, any, string, any];   // name, reply, engine, fallback
  const engines: Engine[] = [
    ["a Claude reply", { engine: "claude" }, "claude", null],
    ["a reply that doesn't say (a server before 0.9.0)", {}, "claude", null],
    ["a Mac reply", { engine: "mac" }, "mac", null],
    ["a stand-in after offline", { engine: "mac", fallback: "offline" }, "mac", { kind: "offline", until: undefined }],
    ["a stand-in after the plan limit, with its time", { engine: "mac", fallback: "limit", until: "2030-01-01T15:00:00Z" }, "mac", { kind: "limit", until: "2030-01-01T15:00:00Z" }],
  ];
  for (const [name, d, engine, fallback] of engines) {
    test(`the reply says what wrote it: ${name}`, () => {
      const s = replied(d);
      expect(s.st.phase).toBe("ready");
      expect(s.st.engine).toBe(engine);
      expect(s.st.fallback).toEqual(fallback);
    });
  }

  // The stand-in's tag: kind info with the still dot, "Translated on this Mac", the why in its title.
  type Why = [string, any, string | RegExp];
  const whys: Why[] = [
    ["offline", {}, "Claude couldn't be reached, so this Mac translated it, without your voice guide."],
    ["limit", {}, "Claude's plan limit was reached, so this Mac translated it, without your voice guide."],
    ["limit", { until: new Date(Date.now() + 3 * 86400_000).toISOString() }, /^Claude's plan limit was reached until [A-Z][a-z]{2} \d{1,2}:\d{2}\s?[AP]M, so this Mac translated it, without your voice guide\.$/],
    ["limit", { until: "not a date" }, "Claude's plan limit was reached, so this Mac translated it, without your voice guide."],
    ["login", {}, "Claude Code isn't signed in, so this Mac translated it, without your voice guide."],
    ["update", {}, "Claude Code needs an update, so this Mac translated it, without your voice guide."],
    ["missing", {}, "Claude Code isn't installed, so this Mac translated it, without your voice guide."],
    ["failed", {}, "Claude didn't answer, so this Mac translated it, without your voice guide."],
    ["something new", {}, "Claude didn't answer, so this Mac translated it, without your voice guide."],
  ];
  for (const [kind, extra, title] of whys) {
    test(`a stand-in after ${kind}${extra.until ? ` (until ${extra.until})` : ""}: the tag and its title`, () => {
      const v = view(replied({ engine: "mac", fallback: kind, ...extra }));
      expect(v.state).toBe("ready");
      expect(v.tag.kind).toBe("info");
      expect(v.tag.text).toBe("Translated on this Mac");
      if (typeof title === "string") expect(v.tag.title).toBe(title); else expect(v.tag.title).toMatch(title);
      expect(v.actions).toEqual(kind === "limit" ? [] : [{ act: "retry-claude", label: "Try Claude again" }]);
    });
  }

  type Place = [string, () => S, string | null];   // name, state, tag
  const places: Place[] = [
    ["voice findings join the stand-in's title; the tag stays the stand-in's", () => replied({ engine: "mac", fallback: "offline", lint: [{ level: "warning", message: "Stiff" }, { level: "warning", message: "Long" }] }), "info: Translated on this Mac"],
    ["a plain Mac reply has no tag", () => replied({ engine: "mac" }), null],
    ["a plain Mac reply with a finding shows the finding", () => replied({ engine: "mac", lint: [{ level: "warning", message: "Stiff" }] }), "needs: Stiff"],
    ["a send's notice wins over the stand-in", () => sendAnd(replied({ engine: "mac", fallback: "offline" }), { ok: false, reason: "not-front" }), "error: Teams didn't come forward"],
    ["Teams closed wins over the stand-in", () => withTeams(replied({ engine: "mac", fallback: "offline" }), CLOSED), "idle: Teams isn't open"],
    ["out of date wins over the stand-in", () => type(replied({ engine: "mac", fallback: "offline" }), ES + "!"), "error: Translation out of date"],
  ];
  for (const [name, mk, tag] of places) test(name, () => expect(tagOf(mk())).toBe(tag));

  test("the stand-in's title holds its findings, one per line, after the why", () => {
    const v = view(replied({ engine: "mac", fallback: "offline", lint: [{ level: "warning", message: "Stiff" }, { level: "warning", message: "Long" }] }));
    expect(v.tag.title).toBe("Claude couldn't be reached, so this Mac translated it, without your voice guide.\nStiff\nLong");
  });

  // Adjust: on a Claude reply with a Claude model only. Off (shown, with its title) on a Mac reply or with the Mac chosen.
  type Adj = [string, () => S, string, boolean, string | null];   // name, state, model, canAdjust, adjustOff
  const adjusts: Adj[] = [
    ["a Claude reply, Sonnet", () => replied({ engine: "claude" }), "sonnet", true, null],
    ["a Claude reply, no settings yet", () => replied({ engine: "claude" }), "", true, null],
    ["a Mac reply, Mac chosen", () => replied({ engine: "mac" }), "mac", false, "Adjust needs Haiku, Sonnet or Opus"],
    ["a stand-in, Sonnet chosen", () => replied({ engine: "mac", fallback: "offline" }), "sonnet", false, "Adjust needs Haiku, Sonnet or Opus"],
    ["a Claude reply, then Mac chosen", () => replied({ engine: "claude" }), "mac", false, "Adjust needs Haiku, Sonnet or Opus"],
    ["typed in an empty strip, Mac chosen", () => { const s = start(); const f = { es: "", en: EN }; return { st: SS.editedEnglish(s.st, EN, f, "English"), f }; }, "mac", false, "Adjust needs Haiku, Sonnet or Opus"],
    ["typed in an empty strip, Opus", () => { const s = start(); const f = { es: "", en: EN }; return { st: SS.editedEnglish(s.st, EN, f, "English"), f }; }, "opus", true, null],
    ["nothing translated, Mac chosen (hidden, not off)", () => start(), "mac", false, null],
    ["a Mac reply written for another chat (hidden: the chat comes first)", () => withTeams(replied({ engine: "mac" }), DANIEL), "mac", false, null],
  ];
  for (const [name, mk, model, can, off] of adjusts) {
    test(`Adjust: ${name}`, () => {
      const s = mk();
      expect(SS.canAdjust(s.st, s.f, model)).toBe(can);
      expect(SS.adjustOff(s.st, s.f, model)).toBe(off);
      if (!can) expect(SS.adjustStart(s.st, s.f, "corto", "English", model)).toBeNull();
    });
  }

  type Tone = [string, string | null];
  const tones: Tone[] = [["haiku", null], ["sonnet", null], ["opus", null], ["", null], ["mac", "Formal needs Haiku, Sonnet or Opus"]];
  for (const [model, off] of tones) test(`Normal and Formal with the model ${model || "unknown"}: ${off ? "off" : "on"}`, () => expect(SS.toneOff(model)).toBe(off));

  test("the language button's one-time target still works on a Mac reply", () => {
    const s = replied({ engine: "mac", language: "Português", from: "chat" });
    expect(SS.canRetarget(s.st, s.f, "English")).toBe(true);
    const go = SS.translateStart(s.st, s.f, { auto: true, target: "English" });
    expect(go.body.target).toBe("English");
    expect(go.st.engine).toBe("");
    expect(go.st.fallback).toBeNull();
  });

  // The new errors, from a translation (and an adjust refused because the model is the Mac's).
  type Err = [string, any, string, string, string, string[]];   // name, reply, data-state, tag, title, buttons
  const errors: Err[] = [
    ["this Mac can't translate", { error: "mac" }, "mac", "idle: Can't translate on this Mac", "Needs macOS 26 or later.", []],
    ["the language pair isn't on this Mac", { error: "language", source: "Español", language: "日本語" }, "language", "idle: Español to 日本語 isn't on this Mac", "Download it in System Settings, General, Language & Region, Translation Languages.", ["Try again"]],
    ["the language pair, with no source named", { error: "language", language: "日本語" }, "language", "idle: 日本語 isn't on this Mac", "Download it in System Settings, General, Language & Region, Translation Languages.", ["Try again"]],
    ["the language pair, with nothing named", { error: "language" }, "language", "idle: This language isn't on this Mac", "Download it in System Settings, General, Language & Region, Translation Languages.", ["Try again"]],
  ];
  for (const [name, d, state, tag, title, buttons] of errors) {
    test(`an error: ${name}`, () => {
      let s = type(start(), ES);
      s = applied(s, SS.translateStart(s.st, s.f).st);
      s = applied(s, SS.translateDone(s.st, s.f, d));
      expect(s.st.phase).toBe("error");
      const v = view(s);
      expect(v.state).toBe(state);
      expect(tagOf(s)).toBe(tag);
      expect(v.tag.title).toBe(title);
      expect(labels(s)).toEqual(buttons);
      expect(SS.canTranslate(s.st, s.f)).toBe(true);
    });
  }
  test("an adjust refused because the model is the Mac's says Adjust needs a Claude model, and the English stays", () => {
    let s = replied({ engine: "claude" });
    s = applied(s, SS.adjustStart(s.st, s.f, "corto", "English", "sonnet").st);
    const r = SS.adjustDone(s.st, s.f, { error: "mac" });
    expect(r.st.phase).toBe("ready");
    expect(r.st.en).toBe(EN);
    expect(tagOf({ ...s, st: r.st })).toBe("idle: Adjust needs Haiku, Sonnet or Opus");
    expect(labels({ ...s, st: r.st })).toEqual([]);
  });

  // A Claude error in the server's state never keeps Translate off: the Mac may stand in.
  type Srv = [string, string, any, string | null, string?];   // name, model, translator, idle tag, data-state
  const servers: Srv[] = [
    ["Claude offline", "sonnet", { status: "error", error: "offline" }, null],
    ["Claude at its plan limit", "opus", { status: "error", error: "limit", until: "2030-01-01T15:00:00Z" }, null],
    ["Claude Code not signed in", "haiku", { status: "error", error: "login" }, null],
    ["Claude Code needs an update", "sonnet", { status: "error", error: "update" }, null],
    ["Claude Code missing", "sonnet", { status: "error", error: "missing" }, null],
    ["the translator failed", "sonnet", { status: "error", error: "failed" }, null],
    ["the Mac chosen, its helper starting", "mac", { status: "starting" }, null],
    ["the Mac chosen, and the guide missing (the Mac needs none)", "mac", { status: "ready", guide: "missing" }, null],
    ["the Mac chosen, and it can't translate", "mac", { status: "error", error: "mac" }, "idle: Can't translate on this Mac", "mac"],
    ["a Claude model and the guide missing (as before)", "sonnet", { status: "ready", guide: "missing" }, "idle: Voice guide not set", "noguide"],
  ];
  for (const [name, model, translator, tag, state] of servers) {
    test(`Translate stays on: ${name}`, () => {
      const idle = start(), typed = type(start(), ES), srv = srvOf(model, translator);
      expect(tagOf(idle, srv)).toBe(tag);
      if (state) expect(view(idle, srv).state).toBe(state);
      expect(SS.canTranslate(typed.st, typed.f)).toBe(true);
      expect(SS.translateStart(typed.st, typed.f)).not.toBeNull();
    });
  }

  type Reset = [string, (s: S) => St];
  const resets: Reset[] = [
    ["Esc", (s) => SS.clearAll(s.st).st],
    ["a send", (s) => SS.sendDone(SS.sendStart(s.st, s.f, false, "send").st, { ok: true }, "9:41 AM")],
    ["a new translation", (s) => { const t = type(s, "Otra cosa"); return SS.translateStart(t.st, t.f).st; }],
  ];
  for (const [name, go] of resets) {
    test(`${name} forgets that the Mac stood in`, () => {
      const n = go(replied({ engine: "mac", fallback: "offline" }));
      expect(n.engine).toBe("");
      expect(n.fallback).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------------------- 0.10.0
describe("six quick fixes (0.10.0)", () => {
  function replied(d: any, teams: any = PRIYA): S {
    let s = type(start(teams), ES);
    s = applied(s, SS.translateStart(s.st, s.f).st);
    return applied(s, SS.translateDone(s.st, s.f, { text: EN, language: "English", from: "target", lint: [], ...d }));
  }
  const srvOf = (model: string) => ({ translator: { status: "ready", model }, settings: { model } });

  test("an unconfirmed send keeps the English, with no button and a title that says why", () => {
    const s = sendAnd(ready(), { ok: false, reason: "unconfirmed" });
    const v = view(s);
    expect(v.state).toBe("error");
    expect(v.tag).toEqual({ kind: "error", text: "Not confirmed. Check the chat", title: "Teams emptied its box, but the strip couldn't see the chat to check the message is there." });
    expect(v.actions).toEqual([]);
    expect(s.st.leftover).toBeNull();   // like not-posted: the box was emptied, so nothing of ours sits in it
    expect(canSend(s)).toBe(true);
  });
  test("a send's notice without a title has none", () => {
    expect(view(sendAnd(ready(), { ok: false, reason: "not-posted" })).tag).toEqual({ kind: "error", text: "Not in the chat. Check it" });
  });

  // Try Claude again: [name, state, model, actions]
  const RETRY = [{ act: "retry-claude", label: "Try Claude again" }];
  type Retry = [string, () => S, string, any[]];
  const retries: Retry[] = [
    ["a stand-in after offline, Sonnet", () => replied({ engine: "mac", fallback: "offline" }), "sonnet", RETRY],
    ["a stand-in after login, Haiku", () => replied({ engine: "mac", fallback: "login" }), "haiku", RETRY],
    ["a stand-in after update, Opus", () => replied({ engine: "mac", fallback: "update" }), "opus", RETRY],
    ["a stand-in after missing", () => replied({ engine: "mac", fallback: "missing" }), "sonnet", RETRY],
    ["a stand-in after failed", () => replied({ engine: "mac", fallback: "failed" }), "sonnet", RETRY],
    ["a stand-in with a voice finding", () => replied({ engine: "mac", fallback: "offline", lint: [{ level: "warning", message: "Stiff" }] }), "sonnet", RETRY],
    ["a stand-in after the plan limit: no button", () => replied({ engine: "mac", fallback: "limit", until: "2030-01-01T15:00:00Z" }), "sonnet", []],
    ["a stand-in, then Mac chosen: no button", () => replied({ engine: "mac", fallback: "offline" }), "mac", []],
    ["a plain Mac reply: no button", () => replied({ engine: "mac" }), "mac", []],
    ["a Claude reply: no button", () => replied({ engine: "claude" }), "sonnet", []],
    ["a stand-in out of date: no button", () => type(replied({ engine: "mac", fallback: "offline" }), ES + "!"), "sonnet", []],
    ["a stand-in with Teams closed: Open Teams only", () => withTeams(replied({ engine: "mac", fallback: "offline" }), CLOSED), "sonnet", [{ act: "open-teams", label: "Open Teams" }]],
  ];
  for (const [name, mk, model, actions] of retries) test(`Try Claude again: ${name}`, () => expect(view(mk(), srvOf(model)).actions).toEqual(actions));

  // Fix it on a voice finding: [name, state, model, actions]
  const FIX = [{ act: "fix-voice", label: "Fix it" }];
  const fixes: Retry[] = [
    ["a Claude reply with a warning", () => replied({ engine: "claude", lint: [{ level: "warning", message: "Stiff" }] }), "opus", FIX],
    ["a Claude reply with two findings", () => replied({ engine: "claude", lint: [{ level: "warning", message: "Stiff" }, { level: "error", message: "Ruled out" }] }), "sonnet", FIX],
    ["a Mac reply with a finding: no button", () => replied({ engine: "mac", lint: [{ level: "warning", message: "Stiff" }] }), "mac", []],
    ["a Claude reply with no finding: no button", () => replied({ engine: "claude" }), "opus", []],
  ];
  for (const [name, mk, model, actions] of fixes) test(`Fix it: ${name}`, () => expect(view(mk(), srvOf(model)).actions).toEqual(actions));

  test("Try Claude again asks for the same text as a normal request, and a Claude answer drops the stand-in", () => {
    const s = replied({ engine: "mac", fallback: "offline" });
    const go = SS.translateStart(s.st, s.f, { auto: false });
    expect(go).not.toBeNull();
    expect(go.body).toEqual({ text: ES, register: "normal", context: { chat: "Priya Raman", from: "Priya Raman", last: PRIYA.last } });
    expect(go.st.fallback).toBeNull();
    const t = applied(applied(s, go.st), SS.translateDone(go.st, s.f, { text: EN, language: "English", from: "target", lint: [], engine: "claude" }));
    expect(t.st.engine).toBe("claude");
    expect(tagOf(t, srvOf("sonnet"))).toBeNull();
    expect(view(t, srvOf("sonnet")).actions).toEqual([]);
  });
  test("Try Claude again keeps a one-time target for the same text", () => {
    let s = type(start(PRIYA), ES);
    const go = SS.translateStart(s.st, s.f, { target: "Português" });
    s = applied(applied(s, go.st), SS.translateDone(go.st, s.f, { text: EN, language: "Português", from: "target", lint: [], engine: "mac", fallback: "offline" }));
    expect(SS.translateStart(s.st, s.f, { auto: true }).body.target).toBe("Português");
  });

  // The language button that does nothing: [name, state, target, inert]
  type Inert = [string, () => S, string, boolean];
  const inerts: Inert[] = [
    ["a reply in the target, Auto off", () => replied({}), "English", true],
    ["a reply in the target with a draft in Teams", () => sendAnd(ready(), { ok: false, reason: "draft" }), "English", true],
    ["a reply in another language (a click writes it in the target)", () => replied({ language: "Português" }), "English", false],
    ["a reply Auto took from the chat, in the target", () => replied({ from: "chat" }), "English", false],
    ["a reply Auto took from the chat, in another language", () => replied({ language: "Português", from: "chat" }), "English", false],
    ["no translation: no button", () => start(), "English", false],
    ["sent: no button", () => sendAnd(ready(), { ok: true }), "English", false],
  ];
  for (const [name, mk, target, want] of inerts) test(`the language button does nothing: ${name}`, () => expect(SS.langInert(mk().st, target)).toBe(want));
  test("Auto on for the request, with no clear chat language: the button shows Auto, so it keeps today's steps", () => {
    let s = type(start(PRIYA), ES);
    const go = SS.translateStart(s.st, s.f, { auto: true });
    s = applied(applied(s, go.st), SS.translateDone(go.st, s.f, { text: EN, language: "English", from: "target", lint: [] }));
    expect(SS.langView(s.st, "English").auto).toBe(true);
    expect(SS.langInert(s.st, "English")).toBe(false);
  });

  const placeholders: [any, string][] = [
    ["English", "English"],
    ["Português", "Português"],
    ["日本語", "日本語"],
    ["", "English"],
    [undefined, "English"],
  ];
  for (const [target, want] of placeholders) test(`the reply box's placeholder for ${JSON.stringify(target)}`, () => expect(SS.enPlaceholder(target)).toBe(want));
});

// ---------------------------------------------------------------------------------------- 0.12.0
describe("recent messages (0.12.0)", () => {
  const T = "9:41 AM";
  // Esc, as the page presses it: with the boxes it shows and the time.
  const esc = (s: S): S => applied(s, SS.clearAll(s.st, s.f, T).st);
  const send = (s: S, mode = "send"): S => {
    const go = SS.sendStart(s.st, s.f, false, mode);
    if (!go) throw new Error("Send was off");
    return applied(s, SS.sendDone(go.st, { ok: true }, T));
  };
  // A reply, sent or cleared: n messages, each with its own words.
  const words = (i: number) => `Reply number ${i}, for the budget review.`;
  // A new strip that carries the recent messages of another (the page keeps one state; the helpers start fresh ones).
  const carry = (from: S, to: S): S => ({ ...to, st: { ...to.st, recent: from.st.recent, recentId: from.st.recentId } });
  function kept(n: number, how: (s: S) => S = esc): S {
    let s = start();
    for (let i = 1; i <= n; i++) s = how(carry(s, ready(`${ES} ${i}`, words(i))));
    return s;
  }
  const ens = (s: S) => s.st.recent.map((r: any) => r.en);

  // What each way of leaving a message keeps: [name, the strip after it, the replies kept newest first, how the newest ended]
  type Keep = [string, () => S, string[], string | null];
  const keeps: Keep[] = [
    ["a confirmed send keeps it", () => send(ready()), [EN], "sent"],
    ["Put in Teams keeps it", () => send(ready(), "leave"), [EN], "leave"],
    ["a failed send keeps nothing (the English stays)", () => sendAnd(ready(), { ok: false, reason: "not-front" }), [], null],
    ["Esc with a reply keeps it, as the boxes show it", () => esc({ ...ready(), f: { es: ES, en: EN + " Edited." } }), [EN + " Edited."], "cleared"],
    ["Esc with a reply out of date keeps both boxes as they are", () => esc(type(ready(), ES + " Y mañana.")), [EN], "cleared"],
    ["Esc with a draft in Teams keeps it", () => esc(sendAnd(ready(), { ok: false, reason: "draft" })), [EN], "cleared"],
    ["Esc with written text only keeps nothing", () => esc(type(start(), ES)), [], null],
    ["Esc on an empty strip keeps nothing", () => esc(start()), [], null],
    ["Esc while translating keeps nothing", () => { const s = type(start(), ES); return esc(applied(s, SS.translateStart(s.st, s.f).st)); }, [], null],
    ["Esc on a question keeps nothing", () => { const s = type(start(), ES); const go = SS.translateStart(s.st, s.f); return esc(applied(applied(s, go.st), SS.translateDone(go.st, s.f, { question: "This Thursday?" }))); }, [], null],
    ["six messages keep the newest five, newest first", () => kept(6), [6, 5, 4, 3, 2].map(words), "cleared"],
    ["the same message twice shows once, at the front", () => esc(carry(send(carry(kept(2), ready())), ready())), [EN, words(2), words(1)], "cleared"],
  ];
  for (const [name, mk, want, how] of keeps) test(name, () => {
    const s = mk();
    expect(ens(s)).toEqual(want);
    expect(s.st.recent[0]?.how ?? null).toBe(how);
    expect(s.st.recent.length).toBeLessThanOrEqual(SS.RECENT_MAX);
  });

  test("each one keeps what was written, the reply, its language, the chat and the time", () => {
    let s = type(start(PRIYA), ES);
    const go = SS.translateStart(s.st, s.f, { auto: true });
    s = applied(applied(s, go.st), SS.translateDone(go.st, s.f, { text: "Você consegue revisar o orçamento?", language: "Português", from: "chat", lint: [] }));
    const r = send(s).st.recent[0];
    expect([r.es, r.en, r.language, r.from, r.chat, r.at, r.how]).toEqual([ES, "Você consegue revisar o orçamento?", "Português", "chat", "Priya Raman", T, "sent"]);
  });

  // When ⌘Z brings one back: [name, the strip, the boxes, can]
  type Can = [string, () => S, boolean];
  const withOne = () => esc(ready());
  const cans: Can[] = [
    ["both boxes empty, one kept", withOne, true],
    ["right after a send, while Sent shows", () => send(ready()), true],
    ["nothing kept", () => start(), false],
    ["text in the box you write in", () => type(withOne(), "Hola"), false],
    ["text typed in the reply box", () => { const s = withOne(); return { st: SS.editedEnglish(s.st, "Hi", s.f, "English"), f: { es: "", en: "Hi" } }; }, false],
    ["while dictating", () => { const s = withOne(); return applied(s, SS.dictStart(s.st, s.f).st); }, false],
    ["while the last words of a dictation come in", () => { let s = withOne(); s = applied(s, SS.dictStart(s.st, s.f).st); return applied(s, SS.dictStop(s.st).st); }, false],
    ["while sending (the boxes as the state says)", () => { const s = esc(ready()); const r = ready(); return { st: { ...SS.sendStart(r.st, r.f, false, "send").st, recent: s.st.recent }, f: { es: "", en: "" } }; }, false],
    ["while adjusting", () => { const s = esc(ready()); return { st: { ...s.st, phase: "adjusting" }, f: s.f }; }, false],
  ];
  for (const [name, mk, want] of cans) test(`⌘Z brings one back: ${name} → ${want}`, () => {
    const s = mk();
    expect(SS.canRestore(s.st, s.f)).toBe(want);
    expect(!!SS.restoreRecent(s.st, s.f)).toBe(want);
  });

  test("⌘Z brings back the newest into the ready phase, for its chat, and it leaves the list; ⌘Z again brings the one before", () => {
    let s = kept(2);
    s = applied(s, SS.restoreRecent(s.st, s.f));
    expect([s.st.phase, s.f.es, s.f.en, s.st.chatFor]).toEqual(["ready", `${ES} 2`, words(2), "Priya Raman"]);
    expect(ens(s)).toEqual([words(1)]);
    expect(SS.canSend(s.st, s.f, false)).toBe(true);
    expect(SS.restoreRecent(s.st, s.f)).toBeNull();   // the boxes hold it now: ⌘Z is theirs
    s = esc(s);
    expect(ens(s)).toEqual([words(2), words(1)]);
    s = applied(s, SS.restoreRecent(s.st, s.f));
    expect(s.f.en).toBe(words(2));
  });
  test("one written for another chat comes back as Written for it, with Send off", () => {
    let s = esc(ready());
    s = withTeams(s, DANIEL);
    s = applied(s, SS.restoreRecent(s.st, s.f));
    expect(tagOf(s)).toBe("error: Written for Priya Raman");
    expect(SS.canSend(s.st, s.f, false)).toBe(false);
  });
  test("its language comes back with how it was chosen", () => {
    let s = type(start(PRIYA), ES);
    const go = SS.translateStart(s.st, s.f, { auto: true });
    s = applied(applied(s, go.st), SS.translateDone(go.st, s.f, { text: "Você consegue?", language: "Português", from: "chat", lint: [] }));
    s = esc(s);
    s = applied(s, SS.restoreRecent(s.st, s.f));
    expect(SS.langView(s.st, "English")).toMatchObject({ auto: true, name: "Português", other: true });
  });

  test("a click in the menu brings back that one, even the oldest of five", () => {
    let s = kept(5);
    const oldest = s.st.recent[4];
    s = applied(s, SS.pickRecent(s.st, s.f, oldest.id, T));
    expect(s.f.en).toBe(words(1));
    expect(ens(s)).toEqual([5, 4, 3, 2].map(words));
  });
  test("a click with a reply on show keeps that one first, as Esc would, and the list stays five", () => {
    let s = kept(5);
    const oldest = s.st.recent[4].id;
    s = carry(s, ready(ES, "The one on show."));
    s = applied(s, SS.pickRecent(s.st, s.f, oldest, T));
    expect(s.f.en).toBe(words(1));
    expect(ens(s)).toEqual(["The one on show.", ...[5, 4, 3, 2].map(words)]);
  });
  test("a click with written text and no reply keeps that text first, and bringing it back gives the text to translate", () => {
    let s = kept(2);
    const target = s.st.recent[1].id;
    s = type(s, "Texto sin traducir todavía");
    s = applied(s, SS.pickRecent(s.st, s.f, target, T));
    expect(s.st.recent[0]).toMatchObject({ es: "Texto sin traducir todavía", en: "" });
    s = applied(s, SS.pickRecent(s.st, s.f, s.st.recent[0].id, T));
    expect(s.f.es).toBe("Texto sin traducir todavía");
    expect(s.f.en).toBe("");
    expect(s.st.phase).toBe("idle");
  });
  test("a click with the reply deleted by hand keeps the written text first", () => {
    let s = kept(2);
    const target = s.st.recent[1].id;
    s = carry(s, ready("hola equipo", "Hello team."));
    s = { ...s, f: { es: "hola equipo", en: "" } };
    s = applied(s, SS.pickRecent(s.st, s.f, target, T));
    expect(s.st.recent[0]).toMatchObject({ es: "hola equipo", en: "" });
  });
  test("a click does nothing while something runs, or for one no longer there", () => {
    let s = esc(ready());
    const id = s.st.recent[0].id;
    expect(SS.pickRecent(applied(s, SS.dictStart(s.st, s.f).st).st, s.f, id, T)).toBeNull();
    expect(SS.pickRecent(s.st, s.f, id + 99, T)).toBeNull();
  });

  // The menu button's words: [the reply, the words]
  const cuts: [string, string][] = [
    ["Sure", "Sure"],
    ["Thanks, that works for me", "Thanks, that works for…"],
    ["Exactly twenty-four ch.", "Exactly twenty-four ch."],
    ["Can we move\nthe call   to Friday afternoon?", "Can we move the call to…"],
    ["Supercalifragilisticexpialidocious", "Supercalifragilisticexpi…"],
  ];
  for (const [en, want] of cuts) test(`the button for ${JSON.stringify(en)} reads ${JSON.stringify(want)}`, () => expect(SS.recentLabel({ en, es: "x" })).toBe(want));
  test("a message typed straight in the reply box has no written text; one with no reply shows the written text", () => {
    expect(SS.recentLabel({ en: "", es: "Hola" })).toBe("Hola");
  });
  const titles: [any, string][] = [
    [{ how: "sent", chat: "Priya Raman", at: T }, "Sent to Priya Raman at 9:41 AM"],
    [{ how: "leave", chat: "Priya Raman", at: T }, "Left in Teams for Priya Raman at 9:41 AM"],
    [{ how: "cleared", chat: "Priya Raman", at: T }, "Cleared at 9:41 AM"],
    [{ how: "sent", chat: "", at: "" }, "Sent"],
  ];
  for (const [r, want] of titles) test(`the button's title: ${want}`, () => expect(SS.recentTitle(r)).toBe(want));
});

describe("the update checks' tags (0.12.0)", () => {
  const srv = (translator: any = {}, model = "sonnet") => ({ translator: { status: "ready", guide: "ok", ...translator }, settings: { model } });
  const CHANGED = { ...PRIYA, check: "changed", missing: ["box", "title"] };
  const CLAUDE = { check: "changed", missing: ["--input-format", "--system-prompt-file"] };
  // [name, the strip, the server's state, the tag]
  type Tag = [string, () => S, any, string | null];
  const tags: Tag[] = [
    ["Teams changed, idle", () => start(CHANGED), srv(), "needs: Teams changed. Sending may fail"],
    ["Teams changed, with written text (still idle)", () => type(start(CHANGED), ES), srv(), "needs: Teams changed. Sending may fail"],
    ["Teams changed, a reply on show: not while it shows", () => ready(ES, EN, CHANGED), srv(), null],
    ["Teams checked ok", () => start({ ...PRIYA, check: "ok" }), srv(), null],
    ["Teams changed but closed: Teams isn't open", () => start({ ...CLOSED, check: "changed" }), srv(), "idle: Teams isn't open"],
    ["Teams changed, no chat open: that says it first", () => start({ ...NOCHAT, check: "changed" }), srv(), "idle: No chat open in Teams"],
    ["Claude Code changed, idle", () => start(), srv(CLAUDE), "needs: Claude Code changed. The strip may fail"],
    ["Claude Code changed, but the model is this Mac's", () => start(), srv(CLAUDE, "mac"), null],
    ["Claude Code not checked yet", () => start(), srv({ check: null }), null],
    ["both changed: Teams first", () => start(CHANGED), srv(CLAUDE), "needs: Teams changed. Sending may fail"],
    ["no voice guide wins over both", () => start(CHANGED), srv({ ...CLAUDE, guide: "missing" }), "idle: Voice guide not set"],
  ];
  for (const [name, mk, server, want] of tags) test(name, () => expect(tagOf(mk(), server)).toBe(want));
  test("the titles say what moved and which flags are gone", () => {
    expect(view(start(CHANGED), srv()).tag.title).toBe("This version of Teams moved something the strip reads: the message box and the chat title. Sends may stop; the strip needs an update.");
    expect(view(start({ ...PRIYA, check: "changed" }), srv()).tag.title).toBe("This version of Teams moved something the strip reads. Sends may stop; the strip needs an update.");
    expect(view(start(), srv(CLAUDE)).tag.title).toBe("This version of Claude Code lacks --input-format and --system-prompt-file, which the strip passes. Translations may fail; the strip needs an update.");
    expect(SS.teamsChangedTitle(["box", "list", "title"])).toBe("This version of Teams moved something the strip reads: the message box, the message list and the chat title. Sends may stop; the strip needs an update.");
    expect(view(start(CHANGED), srv()).actions).toEqual([]);
  });
});
