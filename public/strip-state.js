"use strict";
// ---------------------------------------------------------------------------------------------
// The strip's state, its transitions and what it shows, as plain functions with no DOM, no timers
// and no requests: the page (index.html) keeps the elements, the events, the bridge and the
// requests, and calls these. Loaded with a script tag, no build step; test/state.test.ts loads the
// same file and checks the transitions with tables of cases.
//
// A state is a plain object (create()). Every transition takes a state and returns a new one; none
// changes the one it was given. What the text boxes hold right now comes in as `f` = { es, en }, the
// raw values of the two boxes. When a transition writes a box itself (the English that came back,
// the Spanish that dictation heard, a box cleared after sending) it puts the text in `en` / `esText`
// and bumps `enSeq` / `esSeq`: the page writes the box whenever the counter has moved.
// Made-up text only; nothing here stores or logs a message.
// ---------------------------------------------------------------------------------------------
(function (root) {
  const BUSY = ["sending", "adjusting"];

  function create() {
    return {
      phase: "idle",     // idle translating ready adjusting stale question sending sent leave draft error
      register: "normal",
      es: "",            // the Spanish the English answers
      en: "", enSeq: 0,  // the English the state last wrote to its box (the box may hold the user's edits)
      esText: "", esSeq: 0, // the Spanish the state last wrote to its box (dictation, cleared after sending)
      lint: [],          // findings on the English: [{ level, message }]
      language: "",      // the language the translation is in (one of the server's languages, in its own name)
      from: "",          // "chat" when Auto took the language from the other person's last message, else "target"
      langAuto: false,   // Auto was on for the request that wrote it (a one-time target turns it off)
      langWho: "",       // whose last message Auto read: the context's author when it was asked for
      once: "", onceFor: "", // the language button's one-time target, and the Spanish it holds for
      prevLang: null,    // the language the English had before an adjust: { language, from, langAuto }, for undo
      prev: "", prevLint: [], adjusted: false, adjustOpen: false, lastNote: "", adjText: "",
      err: null,         // { kind, until, what, source?, language? } when phase is "error"
      engine: "",        // what wrote the translation on show: "claude", "mac" (this Mac's Translation), or "" (typed, or none yet)
      fallback: null,    // { kind, until } when this Mac translated it because Claude couldn't (the Claude error)
      notice: null,      // a tag over a ready translation: { kind, text, actions, env?, title? }
      sendMode: "send", sentAt: "", sentTo: "", lastText: "", leftover: null,
      chatFor: "",       // the chat the English was written for: what Teams showed when it was asked for
      req: 0,            // bumps whenever an answer in flight stops mattering
      dict: "off",       // off on denied
      dictBase: "", dictStopping: false, dictPrep: false, dictProgress: null, dictNote: null,
      dictName: "",      // the dictation language's name, as the settings' options say it (for "Dictation in … isn't available")
      teams: null,       // the shell's last word on Teams: { open, chat, from, last, draft, shape? }
      layout: "automatic", // the shell's position setting: automatic, below, above, left, right
      access: { accessibility: null, microphone: "unknown" },
      recent: [],        // the last messages, newest first (in memory only: a reload or quit forgets them): see "recent messages"
      recentId: 0,       // the next one's id
    };
  }

  const next = (st, patch) => Object.assign({}, st, patch);
  const trim = s => String(s == null ? "" : s).trim();
  const cleanLint = l => (Array.isArray(l) ? l.filter(f => f && typeof f.message === "string" && f.message) : []);
  const hasText = v => typeof v === "string" && v.trim() !== "";
  // The English box is written by the state: n is a fresh copy.
  function writeEnglish(n, text, lint) { n.en = text; n.enSeq = n.enSeq + 1; n.lint = lint || []; }
  function writeSpanish(n, text) { n.esText = text; n.esSeq = n.esSeq + 1; }

  // What Teams shows, as the context the translator gets.
  function context(teams) {
    if (!teams || !teams.chat) return undefined;
    const c = { chat: teams.chat };
    if (teams.from) c.from = teams.from;
    if (teams.last) c.last = teams.last;
    return c;
  }

  // The English was written for one chat and Teams now shows another: it must not go to the new one by
  // accident. Only while the English is ready (or waiting on a draft); a chat that closed is the
  // "no chat" notice's business, and a translation made with no chat open has no chat to remember.
  function mismatch(st) {
    const t = st.teams;
    return (st.phase === "ready" || st.phase === "draft") && !!st.chatFor && !!t && !!t.chat && t.chat !== st.chatFor;
  }
  // Teams is there but its message box can't be found.
  const shapeUnknown = st => !!st.teams && !!st.teams.open && st.teams.shape === "unknown";
  // More than one message box in Teams (a channel with a reply open) and none has the cursor.
  const shapeSeveral = st => !!st.teams && !!st.teams.open && st.teams.shape === "several";

  // ---------------------------------------------------------------------------- what the strip shows
  const clock = d => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  function untilText(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return "";
    return d.toDateString() === new Date().toDateString() ? clock(d) : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${clock(d)}`;
  }

  // Each error the server can tell apart, as a tag, its buttons and the state the strip takes.
  // extra: what the error said besides its kind ({ source, language } for "language").
  function errorView(kind, until, what, extra) {
    extra = extra || {};
    // This Mac can't translate (macOS before 26): nothing to try again; another model is the way out.
    if (kind === "mac" && what === "adjust") return { state: "mac", tag: { kind: "idle", text: ADJUST_NEEDS }, actions: [] };
    if (kind === "mac") return { state: "mac", tag: { kind: "idle", text: "Can't translate on this Mac", title: "Needs macOS 26 or later." }, actions: [] };
    if (kind === "limit") { const u = untilText(until); return { state: "limit", tag: { kind: "idle", text: u ? `Plan limit reached until ${u}` : "Plan limit reached" }, actions: [] }; }
    if (kind === "guide") return { state: "noguide", tag: { kind: "idle", text: "Voice guide not set" }, actions: [{ act: "guide", label: "Open guide settings" }] };
    const retry = [{ act: what === "adjust" ? "retry-adjust" : "retry", label: "Try again" }];
    // Setup things the user fixes outside the strip: gray, like the plan limit and the guide, and trying again after.
    if (kind === "missing") return { state: "login", tag: { kind: "idle", text: "Install Claude Code" }, actions: retry };
    if (kind === "login") return { state: "login", tag: { kind: "idle", text: "Sign in to Claude Code" }, actions: retry };
    if (kind === "update") return { state: "update", tag: { kind: "idle", text: "Claude Code needs an update" }, actions: retry };
    if (kind === "offline") return { state: "error", tag: { kind: "error", text: "Can't reach Claude" }, actions: retry };
    // The language pair isn't downloaded on this Mac: gray, fixed in System Settings, then tried again.
    if (kind === "language") {
      const src = hasText(extra.source) ? extra.source : "", to = hasText(extra.language) ? extra.language : "";
      const text = src && to ? `${src} to ${to} isn't on this Mac` : to ? `${to} isn't on this Mac` : "This language isn't on this Mac";
      return { state: "language", tag: { kind: "idle", text, title: "Download it in System Settings, General, Language & Region, Translation Languages." }, actions: retry };
    }
    return { state: "error", tag: { kind: "error", text: what === "adjust" ? "Couldn't adjust" : "Couldn't translate" }, actions: retry };
  }

  // ---------------------------------------------------------------------------- this Mac's Translation
  // The model "mac" translates on the Mac with no voice guide, no register and no adjust.
  const ADJUST_NEEDS = "Adjust needs Haiku, Sonnet or Opus";
  const TONE_NEEDS = "Formal needs Haiku, Sonnet or Opus";
  const modelOf = srv => (srv && srv.settings && srv.settings.model) || "";
  // Why this Mac translated it instead of Claude: the Claude error, in words.
  function fallbackWhy(kind, until) {
    if (kind === "offline") return "Claude couldn't be reached";
    if (kind === "limit") { const u = untilText(until); return u ? `Claude's plan limit was reached until ${u}` : "Claude's plan limit was reached"; }
    if (kind === "login") return "Claude Code isn't signed in";
    if (kind === "update") return "Claude Code needs an update";
    if (kind === "missing") return "Claude Code isn't installed";
    return "Claude didn't answer";
  }
  const fallbackTitle = (fb) => `${fallbackWhy(fb.kind, fb.until)}, so this Mac translated it, without your voice guide.`;
  // Normal and Formal: off while the model is this Mac's (it has no register). null when they work.
  const toneOff = model => (model === "mac" ? TONE_NEEDS : null);

  // What the strip says about itself right now: its state name (for color), the tag and its buttons.
  // srv is /api/state's last answer (or null).
  function view(st, srv) {
    const p = st.phase, t = st.teams, tr = (srv && srv.translator) || {}, model = modelOf(srv);
    const v = { state: p, tag: null, actions: [] };
    const tag = (kind, text, actions) => { v.tag = { kind, text }; if (actions) v.actions = actions; };
    if (p === "translating") v.state = tr.status === "starting" ? "starting" : "translating";
    else if (p === "sending") tag("working", st.sendMode === "leave" ? "Putting in Teams…" : "Sending…");
    else if (p === "adjusting") tag("working", "Adjusting…");
    // Sent: in the footer, for a few seconds (fadeDone).
    // "To <chat>" is right beside it, so the tag says only when; its title says to whom.
    else if (p === "sent") { tag("done", `Sent · ${st.sentAt}`); if (st.sentTo) v.tag.title = `Sent to ${st.sentTo} at ${st.sentAt}`; }
    else if (p === "leave") tag("idle", "Left in Teams, not sent");
    else if (p === "error") { const e = errorView(st.err.kind, st.err.until, st.err.what, st.err); v.state = e.state; v.tag = e.tag; v.actions = e.actions; }
    else if (p === "question") tag("asks", "Asks you");
    // Both keep Send off, so both read as errors: red, not the orange of "needs you" (decision 10).
    else if (p === "stale") tag("error", "Translation out of date");
    else if (mismatch(st)) { tag("error", `Written for ${st.chatFor}`); v.state = "written"; }
    else if (p === "draft") tag("needs", "Teams has a draft", [{ act: "add", label: "Add after draft" }, { act: "cancel", label: "Cancel" }]);
    else if (st.notice) { tag(st.notice.kind, st.notice.text, st.notice.actions || []); if (st.notice.title) v.tag.title = st.notice.title; if (st.notice.kind === "error") v.state = "error"; }
    // This Mac's model needs no guide; when its helper can't run, an empty strip says so.
    else if (p === "idle" && model === "mac" && tr.status === "error" && tr.error === "mac") { const e = errorView("mac"); v.state = e.state; v.tag = e.tag; v.actions = e.actions; }
    else if (p === "idle" && model !== "mac" && tr.guide === "missing") { const e = errorView("guide"); v.state = e.state; v.tag = e.tag; v.actions = e.actions; }
    else if (t && !t.open) tag("idle", "Teams isn't open", [{ act: "open-teams", label: "Open Teams" }]);
    // Send can't work: red, like the other states that keep Send off.
    else if (shapeUnknown(st)) tag("error", "Can't find Teams' message box");
    else if (shapeSeveral(st)) tag("needs", "Click the box in Teams first");
    else if (t && t.open && !t.chat) tag("idle", "No chat open in Teams");
    // The update checks (0.12.0), while idle: Teams moved something the strip reads, or Claude Code dropped an
    // option the translator passes. Orange, like the other things that need you; neither blocks anything.
    else if (p === "idle" && t && t.open && t.check === "changed") { tag("needs", "Teams changed. Sending may fail"); v.tag.title = teamsChangedTitle(t.missing); }
    else if (p === "idle" && model !== "mac" && tr.check === "changed") { tag("needs", "Claude Code changed. The strip may fail"); v.tag.title = claudeChangedTitle(tr.missing); }
    // This Mac stood in for Claude: the tag takes the notice's place, and voice findings join its title.
    // "Try Claude again" asks for the same text again, as a normal request; not after the plan limit
    // (the server goes straight to the Mac while it lasts), nor once the Mac is the model chosen.
    else if (p === "ready" && st.fallback) {
      tag("info", "Translated on this Mac", st.fallback.kind !== "limit" && model !== "mac" ? [{ act: "retry-claude", label: "Try Claude again" }] : []);
      v.tag.title = [fallbackTitle(st.fallback)].concat(st.lint.map(f => f.message)).join("\n");
    }
    // A voice finding: "Fix it" asks for an adjust whose note names the findings, as the server's own
    // fix does for errors; not on a reply the Mac made, which can't be adjusted.
    else if (p === "ready" && st.lint.length) {
      tag("needs", st.lint[0].message, st.engine !== "mac" && model !== "mac" ? [{ act: "fix-voice", label: "Fix it" }] : []);
      v.tag.title = st.lint.map(f => f.message).join("\n");
    }
    else if (p === "ready" && st.adjusted) tag("idle", "Adjusted");
    if (p === "ready" && st.adjusted) v.actions = v.actions.concat([{ act: "undo", label: "Undo" }]);
    return v;
  }

  // The update checks' titles: what moved, in words. missing: the shell's anchors ("box", "list", "title"), or the
  // flags Claude Code no longer names; with none given, the title says it without the list.
  const ANCHORS = { box: "the message box", list: "the message list", title: "the chat title" };
  function inWords(list) {
    const l = list.filter(Boolean);
    return l.length <= 1 ? l.join("") : l.length === 2 ? `${l[0]} and ${l[1]}` : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
  }
  function teamsChangedTitle(missing) {
    const what = inWords((Array.isArray(missing) ? missing : []).map(m => ANCHORS[m] || (hasText(m) ? m : "")));
    return `This version of Teams moved something the strip reads${what ? `: ${what}` : ""}. Sends may stop; the strip needs an update.`;
  }
  function claudeChangedTitle(missing) {
    const flags = inWords((Array.isArray(missing) ? missing : []).filter(hasText));
    return flags ? `This version of Claude Code lacks ${flags}, which the strip passes. Translations may fail; the strip needs an update.`
      : "This version of Claude Code lacks an option the strip passes. Translations may fail; the strip needs an update.";
  }

  // The value of the strip's data-teams: what the shell said about Teams, as the page's styles know it.
  function dataTeams(st) {
    const t = st.teams;
    if (!t) return "unknown";
    if (!t.open) return "closed";
    if (shapeUnknown(st)) return "unknown";
    return t.chat ? "ok" : "nochat";
  }

  // The words beside the mic: null when there is nothing to say.
  function dictLabel(st) {
    if (st.dict === "on" && st.dictPrep) return { kind: "prep", text: "Getting dictation ready…" + (st.dictProgress == null ? "" : ` ${Math.round(st.dictProgress * 100)}%`) };
    if (st.dict === "on") return { kind: "listening" };
    if (st.dictNote) return { kind: "note", text: st.dictNote };
    if (st.dict === "denied") return { kind: "denied" };
    return null;
  }

  // The language button beside "To <chat>": what the translation on show is written in, and how it
  // was chosen. null when there's no translation with a language. target is the settings' target.
  // { auto, name, title, other }: auto shows "Auto · " before the name; other says the language isn't
  // the target, so a click translates the same Spanish again in the target (canRetarget).
  const LANG_PHASES = ["ready", "draft", "adjusting", "sending", "stale"];
  function langView(st, target) {
    if (!st.language || !LANG_PHASES.includes(st.phase)) return null;
    const other = !!target && st.language !== target;
    const click = other ? ` Click to send this one in ${target}.` : "";
    let title;
    if (st.from === "chat") title = `The language of ${st.langWho ? `${st.langWho}'s` : "the other person's"} last message.${click}`;
    else if (st.langAuto) title = `The chat has no clear language, so your target.${click}`;
    else title = other ? click.trim() : "Your target language.";
    return { auto: st.langAuto || st.from === "chat", name: st.language, title, other };
  }
  // A language button that does nothing: no "Auto · ", and the reply is in the target, so a click
  // can't write it in another. In a short footer it leaves before the notice's words shorten.
  function langInert(st, target) { const lv = langView(st, target); return !!lv && !lv.auto && !lv.other; }
  // The empty reply box says what it takes: the target, or what you type there sent as is.
  const enPlaceholder = target => (hasText(target) ? target : "English");
  const canRetarget = (st, f, target) => st.phase === "ready" && !!st.language && !!target && st.language !== target && canTranslate(st, f);

  // ---------------------------------------------------------------------------- what can be done
  // The Translate button and ⏎ ask the same thing.
  const canTranslate = (st, f) => !!trim(f.es) && !BUSY.includes(st.phase) && !st.dictStopping;
  // Adjust shows but is off on a translation this Mac made, or while the model is this Mac's: the title
  // says why. null when it isn't off for that reason (it may still be hidden: canAdjust).
  const adjustOff = (st, f, model) => (st.phase === "ready" && !!trim(f.en) && !mismatch(st) && (st.engine === "mac" || model === "mac") ? ADJUST_NEEDS : null);
  const canAdjust = (st, f, model) => st.phase === "ready" && !!trim(f.en) && !mismatch(st) && !adjustOff(st, f, model);
  function canSend(st, f, afterDraft) {
    const t = st.teams;
    if (!(st.phase === "ready" || (afterDraft && st.phase === "draft"))) return false;
    return !!trim(f.en) && !!(t && t.open && t.chat) && !shapeUnknown(st) && !shapeSeveral(st) && !mismatch(st) && st.access.accessibility !== false && !st.dictStopping;
  }

  // ---------------------------------------------------------------------------- translating and adjusting
  // Each start returns { st, body } (the request to make) or null when there is nothing to start.
  // opts: { auto } (the setting, as the request goes out) and target, a one-time language for this
  // request only (the click on the language button): it writes in it with Auto off.
  function translateStart(st, f, opts) {
    opts = opts || {};
    if (!canTranslate(st, f)) return null;
    const text = trim(f.es);
    if (st.phase === "translating" && text === st.es) return null;
    const ctx = context(st.teams);
    // A one-time target holds for the same Spanish (a register switch or a retry), not for new text.
    const target = hasText(opts.target) ? opts.target : st.once && st.onceFor === text ? st.once : "";
    const n = next(st, { req: st.req + 1, es: text, prev: "", prevLint: [], prevLang: null, notice: null, err: null, adjusted: false, adjustOpen: false, phase: "translating", chatFor: (ctx && ctx.chat) || "",
      language: "", from: "", langAuto: !!opts.auto && !target, langWho: (ctx && ctx.from) || "", once: target, onceFor: target ? text : "", engine: "", fallback: null });
    writeEnglish(n, "", []);
    const body = { text, register: st.register, context: ctx };
    if (target) body.target = target;
    return { st: n, body };
  }
  // The answer to the current request (the page drops the ones that no longer count).
  function translateDone(st, f, d) {
    d = d && typeof d === "object" ? d : {};
    if (trim(f.es) !== st.es) return next(st, { phase: "idle" });
    const n = next(st);
    if (hasText(d.question)) { writeEnglish(n, d.question, []); n.phase = "question"; }
    else if (hasText(d.text)) {
      writeEnglish(n, d.text, cleanLint(d.lint)); n.phase = "ready"; n.language = hasText(d.language) ? d.language : ""; n.from = d.from === "chat" ? "chat" : "target";
      n.engine = d.engine === "mac" ? "mac" : "claude";
      // A stand-in: Claude couldn't answer (the error), so this Mac did.
      n.fallback = hasText(d.fallback) ? { kind: d.fallback, until: d.until } : null;
    }
    else { n.err = { kind: d.error || "failed", until: d.until, what: "translate", source: d.source, language: d.language }; n.phase = "error"; }
    return n;
  }

  // An adjust keeps the text's language: `language` is the current text's (the target, if the state
  // never heard one).
  // model: the settings' model (an adjust needs a Claude one).
  function adjustStart(st, f, note, target, model) {
    note = trim(note);
    if (!note || !canAdjust(st, f, model)) return null;
    const text = trim(f.es), current = trim(f.en);
    const n = next(st, { req: st.req + 1, prev: f.en, prevLint: st.lint, prevLang: { language: st.language, from: st.from, langAuto: st.langAuto }, lastNote: note, en: f.en, notice: null, adjustOpen: false, phase: "adjusting", adjText: text });
    return { st: n, body: { text, current, note, register: st.register, context: context(st.teams), language: st.language || target || "English" } };
  }
  // { st, focus }: focus says the Spanish box takes the keyboard back (a new English came back).
  function adjustDone(st, f, d) {
    d = d && typeof d === "object" ? d : {};
    if (trim(f.es) !== st.adjText) return { st: next(st, { phase: "stale" }), focus: false };
    const n = next(st, { phase: "ready" });
    if (hasText(d.text)) {
      writeEnglish(n, d.text, cleanLint(d.lint)); n.adjusted = true;
      // The same language keeps how it was chosen (Auto from the chat stays so); another one is a plain target.
      if (hasText(d.language) && d.language !== st.language) { n.language = d.language; n.from = "target"; n.langAuto = false; }
      return { st: n, focus: true };
    }
    if (hasText(d.question)) {
      // The English stays as it was; the question is shown over it.
      n.notice = { kind: "asks", text: d.question };
    } else {
      const e = errorView(d.error || "failed", d.until, "adjust", d);
      n.notice = { kind: e.tag.kind, text: e.tag.text, actions: e.actions };
    }
    return { st: n, focus: false };
  }

  function undo(st) {
    if (st.phase !== "ready" || !st.adjusted) return st;
    const n = next(st, { adjusted: false });
    writeEnglish(n, st.prev, st.prevLint);
    if (st.prevLang) Object.assign(n, st.prevLang); // the language goes back with the text
    return n;
  }

  // { st, again }: again says the translation is asked for again (in the new register).
  function setRegister(st, r, f) {
    const n = next(st, { register: r });
    if (st.phase === "translating") { n.es = ""; return { st: n, again: true }; }   // the answer in flight was for the other register
    return { st: n, again: st.phase === "ready" && !!trim(f.es) };
  }

  // ---------------------------------------------------------------------------- the fields
  // The Spanish changed. An answer for the old text no longer counts; a translation of it is out of date.
  function typed(st, f) {
    const v = trim(f.es);
    const n = next(st, { notice: null, adjustOpen: false, adjusted: false });
    if (st.phase === "sent" || st.phase === "leave") n.phase = "idle";
    else if (st.phase === "translating") { if (v !== st.es) { n.req = st.req + 1; n.phase = "idle"; } }
    else if (st.phase === "adjusting") { if (v !== st.es) { n.req = st.req + 1; n.phase = "stale"; } }
    else if ((st.phase === "ready" || st.phase === "stale" || st.phase === "draft") && st.en) {
      if (v !== st.es) n.phase = "stale"; else if (st.phase === "stale") n.phase = "ready";
    }
    return n;
  }
  // The English box, edited by hand: a change to the translation on show. In an empty strip (idle:
  // nothing translated yet, or the last send has faded), what you type there is the message itself,
  // in your target language, for the chat open now, so Send works. Emptying it while the Spanish box
  // is empty too empties the strip again. f: the fields; target: the settings' target language.
  function editedEnglish(st, value, f, target) {
    if (st.phase === "idle" && trim(value)) {
      const t = st.teams;
      return next(st, { en: value, lint: [], phase: "ready", es: trim(f && f.es), chatFor: (t && t.chat) || "", language: target || "", from: "target",
        langAuto: false, langWho: "", notice: null, err: null, adjusted: false, adjustOpen: false, prev: "", prevLint: [], prevLang: null, once: "", onceFor: "", engine: "", fallback: null });
    }
    if (st.phase === "ready" && !trim(value) && f && !trim(f.es)) return next(st, { en: value, lint: [], phase: "idle", chatFor: "", language: "", from: "", engine: "", fallback: null });
    return next(st, { en: value, lint: [] });
  }
  const setAdjustOpen = (st, open) => next(st, { adjustOpen: !!open });
  const clearNotice = st => next(st, { notice: null });
  // "Cancel" on the draft notice: back to the translation as it was.
  const cancelDraft = st => next(st, { phase: "ready" });
  // "Sent" (or "Left in Teams") has been up for a few seconds: back to an empty strip.
  const fadeDone = st => (st.phase === "sent" || st.phase === "leave" ? next(st, { phase: "idle" }) : st);

  // Esc: everything back to the start. { st, stopDictation }. A strip with a reply keeps it in the recent
  // messages first (what the boxes hold: f, or the state's own text when the page doesn't say); now is the time.
  function clearAll(st, f, now) {
    f = f || { es: st.es, en: st.en };
    const recent = RECENT_PHASES.includes(st.phase) && trim(f.en)
      ? keepRecent(st, { es: trim(f.es), en: trim(f.en), chat: st.chatFor, at: now, how: "cleared" }) : null;
    const n = next(st, { req: st.req + 1, es: "", prev: "", prevLint: [], notice: null, err: null, adjusted: false, adjustOpen: false, phase: "idle", chatFor: "", dictStopping: false, language: "", from: "", langAuto: false, langWho: "", once: "", onceFor: "", prevLang: null, engine: "", fallback: null });
    if (recent) Object.assign(n, recent);
    writeSpanish(n, ""); writeEnglish(n, "", []);
    const stop = st.dict === "on";
    if (stop) n.dict = "off";
    return { st: n, stopDictation: stop };
  }

  // ---------------------------------------------------------------------------- sending
  // { st, msg } (the message for the shell) or null when Send is off. mode is the settings' "send" or "leave".
  function sendStart(st, f, afterDraft, mode) {
    if (!canSend(st, f, afterDraft)) return null;
    const sendMode = mode === "leave" ? "leave" : "send";
    const chat = (st.teams && st.teams.chat) || "";
    const text = trim(f.en);
    const n = next(st, { sendMode, sentTo: chat, adjustOpen: false, notice: null, phase: "sending", lastText: text });
    const msg = { type: "send", text, mode: sendMode };
    if (chat) msg.chat = chat; // the shell sends only to this chat
    if (afterDraft) msg.afterDraft = true;
    return { st: n, msg };
  }
  // The shell always answers. If it doesn't, the strip must not stay stuck.
  function sendTimeout(st) {
    if (st.phase !== "sending") return st;
    return next(st, { phase: "ready", notice: { kind: "error", text: "Teams didn't answer. Check the chat" } });
  }
  // The shell's answer. now is the time to show beside "Sent to …".
  function sendDone(st, m, now) {
    if (st.phase !== "sending") return st;
    m = m || {};
    if (m.ok) {
      // The shell answers ok only once the message shows in the chat (or sits in Teams' box, in
      // Put in Teams mode): then both boxes empty for the next message, and "Sent · time" stays in the
      // footer. Until then, and on any failure, the English stays here.
      const n = next(st, keepRecent(st, { es: st.es, en: st.lastText, chat: st.sentTo || st.chatFor, at: now, how: st.sendMode === "leave" ? "leave" : "sent" }));
      Object.assign(n, { leftover: null, sentAt: now, es: "", adjusted: false, chatFor: "", language: "", from: "", langAuto: false, langWho: "", once: "", onceFor: "", prevLang: null, engine: "", fallback: null, phase: st.sendMode === "leave" ? "leave" : "sent" });
      writeEnglish(n, "", []); writeSpanish(n, "");
      return n;
    }
    // The text stays, so nothing is lost; each reason says what to do.
    const n = next(st, { phase: "ready" });
    switch (m.reason) {
      case "draft":
        // The "draft" is our own text from a failed try: adding it again would send it twice.
        if (st.leftover && st.leftover === st.lastText) n.notice = { kind: "error", text: "Already in Teams. Not sent" };
        else n.phase = "draft";
        break;
      case "no-teams": n.notice = { kind: "idle", text: "Teams isn't open", actions: [{ act: "open-teams", label: "Open Teams" }], env: true }; break;
      case "no-chat": n.notice = { kind: "idle", text: "No chat open in Teams", env: true }; break;
      case "not-front": n.notice = { kind: "error", text: "Teams didn't come forward" }; break;
      // Teams moved to another chat after you saw "To": nothing was pasted. "To" now shows the new chat.
      case "chat-changed": n.notice = { kind: "error", text: "Chat changed. Not sent" }; break;
      case "mismatch": n.leftover = st.lastText; n.notice = { kind: "error", text: "Teams changed it. Not sent" }; break;
      case "no-access": n.access = Object.assign({}, st.access, { accessibility: false }); break;
      // Return didn't send it: the text is still in the box, so trying again would only find it there.
      case "not-sent": n.leftover = st.lastText; n.notice = { kind: "error", text: "In Teams' box, not sent" }; break;
      // Teams emptied its box but the message never showed in the chat: the English stays here, so
      // nothing is lost. It may still show late, so the notice says to look before sending again.
      case "not-posted": n.notice = { kind: "error", text: "Not in the chat. Check it" }; break;
      // Teams emptied its box after Return, but the chat's message list couldn't be read to see the
      // message there: maybe sent, maybe not. The English stays, with no button, so nothing goes twice.
      case "unconfirmed": n.notice = { kind: "error", text: "Not confirmed. Check the chat", title: "Teams emptied its box, but the strip couldn't see the chat to check the message is there." }; break;
      // Teams emptied its box after the paste, twice, before Return: nothing went out, the English stays.
      case "cleared": n.notice = { kind: "error", text: "Teams cleared it. Not sent" }; break;
      // The box never changed after the paste: nothing is in it.
      // Teams may still take the paste late (the clipboard keeps the English a few seconds): if it
      // lands, the next send finds our own text there, never offers to add it again.
      case "no-paste": n.leftover = st.lastText; n.notice = { kind: "error", text: "Teams didn't take it. Not sent" }; break;
      // Two boxes and none with the cursor, found at send time: nothing was pasted.
      case "which-box": n.notice = { kind: "needs", text: "Click the box in Teams first" }; break;
      // The page isn't the one inside this app: the shell refused to send for it.
      case "not-own-server": n.notice = { kind: "error", text: "Not the app's own page. Not sent" }; break;
      default: n.notice = { kind: "error", text: "Couldn't send" };
    }
    return n;
  }

  // ---------------------------------------------------------------------------- dictation
  // Start: { st, msg } or null. Dictation adds to what's in the box.
  // locale: the settings' dictation language (es-MX when there is none); name: its name, for the notes.
  function dictStart(st, f, locale, name) {
    if (st.dict !== "off" || st.dictStopping || ["sending", "translating", "adjusting"].includes(st.phase)) return null;
    const n = next(st, { dictBase: trim(f.es) ? trim(f.es) + " " : "", dict: "on", dictPrep: false, dictProgress: null, dictNote: null, dictName: hasText(name) ? name : "" });
    return { st: n, msg: { type: "dictation", action: "start", locale: hasText(locale) ? locale : "es-MX" } };
  }
  // Stop: listening ends now, and the last words may still come in (dictStopping) until dictFinish.
  // null when it wasn't listening, so whatever was to follow can run at once.
  function dictStop(st) {
    if (st.dict !== "on") return null;
    return { st: next(st, { dict: "off", dictStopping: true }), msg: { type: "dictation", action: "stop" } };
  }
  const dictFinish = st => next(st, { dictStopping: false });
  // What the shell says about dictation. { st, done }: done says the last words are in, so run what waited on them.
  function onDictation(st, m, f) {
    m = m || {};
    if (m.state === "denied") return { st: next(st, { dict: "denied", dictPrep: false, dictStopping: false }), done: false };
    // macOS is downloading its Spanish model; listening starts by itself once it's there.
    if (m.state === "preparing") {
      if (st.dict !== "on") return { st, done: false };
      return { st: next(st, { dictPrep: true, dictProgress: typeof m.progress === "number" ? m.progress : st.dictProgress == null ? null : st.dictProgress }), done: false };
    }
    if (m.state === "unavailable") {
      return { st: next(st, { dict: "off", dictPrep: false, dictStopping: false, dictNote: st.dictName ? `Dictation in ${st.dictName} isn't available on this Mac` : "Dictation isn't available on this Mac" }), done: false };
    }
    let n = next(st);
    if (m.state === "on" || m.state === "off") { n.dictPrep = false; n.dictProgress = null; }
    if (m.state === "on" && st.dict === "off" && !st.dictStopping) { n.dictBase = trim(f.es) ? trim(f.es) + " " : ""; n.dict = "on"; }
    // The text is the whole transcript so far: it replaces what dictation added.
    if (typeof m.text === "string" && (n.dict === "on" || n.dictStopping)) {
      const text = n.dictBase + m.text;
      writeSpanish(n, text);
      n = typed(n, { es: text });
    }
    if (m.state === "off") {
      if (n.dict === "on") n.dict = "off";
      if (st.dictStopping) return { st: n, done: true };
    }
    return { st: n, done: false };
  }

  // ---------------------------------------------------------------------------- recent messages (0.12.0)
  // The last 5 messages, newest first, in the page's memory only: nothing goes to the server, the shell, the
  // disk or the log, and a reload or quit forgets them. One is kept when a send is confirmed (Sent or Left in
  // Teams) and when Esc clears a strip that had a reply. Each is what was written, the reply, its language and
  // how it was chosen, the chat it was written for, the time, and how it ended (sent, leave or cleared).
  const RECENT_MAX = 5;
  const RECENT_PHASES = ["ready", "draft", "stale", "adjusting"];   // the phases that show a reply Esc would clear
  // The patch that keeps one: { recent, recentId }. The same message again moves to the front instead of showing twice.
  function keepRecent(st, m) {
    const list = Array.isArray(st.recent) ? st.recent : [], id = (st.recentId || 0) + 1;
    const item = { id, es: m.es || "", en: m.en || "", language: st.language || "", from: st.from || "", langAuto: !!st.langAuto, langWho: st.langWho || "",
      chat: m.chat || "", at: m.at || "", how: m.how };
    return { recent: [item].concat(list.filter(r => !(r.es === item.es && r.en === item.en))).slice(0, RECENT_MAX), recentId: id };
  }
  // Something is running that a restore would cut short: dictation, a translation, an adjust or a send.
  const running = st => st.dict === "on" || st.dictStopping || ["translating", "adjusting", "sending"].includes(st.phase);
  // ⌘Z brings back the newest only while both boxes are empty and nothing is running; anywhere else ⌘Z is the boxes' own undo.
  const canRestore = (st, f) => !!(st.recent && st.recent.length) && !trim(f.es) && !trim(f.en) && !running(st);
  // One comes back as it was: the written text and the reply in their boxes, phase ready, written for its chat
  // (so "Written for <chat>" shows when Teams has another chat open). It leaves the list.
  function bringBack(st, item) {
    // A message kept with no reply (written text a Recent click set aside) comes back as text to translate.
    const reply = !!trim(item.en);
    const n = next(st, { req: st.req + 1, recent: st.recent.filter(r => r.id !== item.id), phase: reply ? "ready" : "idle", es: item.es, chatFor: reply ? item.chat : "",
      language: item.language, from: item.from, langAuto: item.langAuto, langWho: item.langWho, once: "", onceFor: "", prevLang: null,
      prev: "", prevLint: [], notice: null, err: null, adjusted: false, adjustOpen: false, engine: "", fallback: null, leftover: null });
    writeSpanish(n, item.es); writeEnglish(n, item.en, []);
    return n;
  }
  // ⌘Z: the newest, or null when ⌘Z is the boxes' own undo.
  function restoreRecent(st, f) {
    return canRestore(st, f) ? bringBack(st, st.recent[0]) : null;
  }
  // A click on one in the menu's Recent row: that one, the same way. The menu is a deliberate choice, so it works
  // with text in the boxes too: what they hold is cleared as Esc clears it, and kept in the list first, with its
  // reply or, written text with none, on its own, so nothing typed is lost.
  // null while something is running, or when the id isn't in the list. now: the time, for the one kept.
  function pickRecent(st, f, id, now) {
    const item = (st.recent || []).find(r => r.id === id);
    if (!item || running(st)) return null;
    let base = next(st, { recent: st.recent.filter(r => r.id !== id) });
    if (trim(f.es) || trim(f.en)) {
      if (!RECENT_PHASES.includes(st.phase) || !trim(f.en)) base = next(base, keepRecent(base, { es: f.es, en: f.en, chat: (st.teams && st.teams.chat) || "", at: now, how: "cleared" }));
      base = clearAll(base, f, now).st;
    }
    return bringBack(base, item);
  }
  // A menu button's words: the reply's first words, about 24 characters, then "…" (the written text when there's no reply).
  function recentLabel(item) {
    const text = String((item && (item.en || item.es)) || "").replace(/\s+/g, " ").trim();
    if (text.length <= 24) return text;
    let cut = text.slice(0, 24);
    const sp = cut.lastIndexOf(" ");
    if (sp >= 12) cut = cut.slice(0, sp);
    return cut.replace(/[\s.,;:!?¿¡-]+$/, "") + "…";
  }
  // Its title: when, and where it went.
  function recentTitle(item) {
    const at = hasText(item.at) ? ` at ${item.at}` : "", to = hasText(item.chat) ? item.chat : "";
    if (item.how === "sent") return to ? `Sent to ${to}${at}` : `Sent${at}`;
    if (item.how === "leave") return to ? `Left in Teams for ${to}${at}` : `Left in Teams${at}`;
    return `Cleared${at}`;
  }

  // ---------------------------------------------------------------------------- what the shell says
  const shellTeams = (st, m) => next(st, { teams: m && typeof m === "object" ? m : null, notice: st.notice && st.notice.env ? null : st.notice });
  // The position setting, as the shell says it (an unknown value keeps the one before).
  const LAYOUTS = ["automatic", "below", "above", "left", "right"];
  const shellLayout = (st, m) => next(st, { layout: m && LAYOUTS.includes(m.value) ? m.value : st.layout });
  // { st, stopDictation }: a mic that is denied ends the dictation.
  function shellAccess(st, m) {
    const n = next(st, { access: { accessibility: m && typeof m.accessibility === "boolean" ? m.accessibility : null, microphone: (m && m.microphone) || "unknown" } });
    let stop = false;
    if (n.access.microphone === "denied") { stop = st.dict === "on"; n.dict = "denied"; n.dictStopping = false; }
    else if (st.dict === "denied") n.dict = "off";
    return { st: n, stopDictation: stop };
  }

  const api = {
    create, context, mismatch, shapeUnknown, shapeSeveral, shellLayout, LAYOUTS, errorView, view, dataTeams, dictLabel, langView, langInert, enPlaceholder, canRetarget, untilText, clock,
    canTranslate, canAdjust, adjustOff, canSend, toneOff, fallbackWhy, ADJUST_NEEDS, TONE_NEEDS,
    translateStart, translateDone, adjustStart, adjustDone, undo, setRegister,
    typed, editedEnglish, setAdjustOpen, clearNotice, cancelDraft, fadeDone, clearAll,
    sendStart, sendTimeout, sendDone,
    dictStart, dictStop, dictFinish, onDictation,
    shellTeams, shellAccess,
    RECENT_MAX, canRestore, restoreRecent, pickRecent, recentLabel, recentTitle, teamsChangedTitle, claudeChangedTitle,
  };
  root.StripState = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
