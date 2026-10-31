// convo-log — records what every agent terminal has shown, and lets you read it back.
//
// Default view (no props().file): the recorder. One row per agent terminal;
// "capture" grabs one, "capture all" walks them in order, "auto" captures the
// agents that are busy (working/blocked/done) every 60 seconds. With
// props().file the same mod becomes a reader window: file name + size + line
// count, refresh, last 400 lines / all.
//
// Capture: `hc read <address> --lines 600` (the address may be remote, such as
// vps-jp/t7). The log only grows: data/convo-log/<machine|local>/<address>.log,
// one block per capture:
//   \n===== 2026-10-31 05:41:02 · working =====\n<text>\n
// Freshly read text is matched against the remembered tail; overlapping lines
// are not written twice; if the two don't line up (clear screen, program
// restart) the whole screen is written as new. Each block is capped at 8 kB;
// anything over keeps only the last lines, noted in the block. What was reused
// for dedup and the running totals live in data/convo-log/state.json. The
// runtime's fs/promises has no appendFile, so "append" is read-all-then-write-
// back — content only ever grows, and only "clear" writes an address's log as
// an empty file.
//
// One known trade-off: every <address>.log is read and written whole, so each
// capture runs through the entire log text. That is the only route with the
// current fs interface (no stat, no append); logs grow by 8 kB per capture,
// which is fine.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Switch } from "gpui-base";
import { agents, panes, hc, theme, settings, props, closeOverlay, openOverlay, exec, appHome } from "herdr";
import * as fs from "fs/promises";

const LINES_READ = 600; // hc read --lines
const KEEP_LINES = 800; // lines of the previous tail kept for dedup
const MAX_BLOCK = 8 * 1024; // byte cap for one append
const AUTO_MS = 60_000;
const TAIL_LINES = 400;
const WORDS = { working: "working", blocked: "blocked", done: "done", idle: "idle" };
const SPINNER = "mods/workspace-chrome/spinner.svg";

const dir = () => `${appHome()}/data/convo-log`;
const statePath = () => `${dir()}/state.json`;
// Remote addresses carry a machine/ prefix (vps-jp/t7); local ones don't.
const machineOf = (address) => (address.includes("/") ? address.split("/")[0] : "local");
const logPath = (address) => `${dir()}/${machineOf(address)}/${address.replace(/\//g, "_")}.log`;

function num(n) {
  if (!(n > 0)) return "0";
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  if (n < 1e7) return `${(n / 1e6).toFixed(2).replace(/0$/, "")}M`;
  return `${Math.round(n / 1e6)}M`;
}

function byteLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

const splitLines = (text) => {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};
const countLines = (text) => (text ? text.split("\n").length - (/\n$/.test(text) ? 1 : 0) : 0);
const pad = (n) => String(n).padStart(2, "0");
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function digest(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

// How many lines the end of the remembered tail and the start of the fresh read
// overlap at most: a terminal scrolls upward, so scrolled-off content shifts the
// window as a whole; the overlapping stretch is what did not move.
function longestShift(prev, cur) {
  const max = Math.min(prev.length, cur.length);
  if (!max) return 0;
  for (let k = max; k > 0; k--) {
    if (prev[prev.length - k] !== cur[0]) continue;
    let ok = true;
    for (let i = 1; i < k; i++) if (prev[prev.length - k + i] !== cur[i]) { ok = false; break; }
    if (ok) return k;
  }
  return 0;
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a, b, limit) {
  let s = 0;
  while (s < limit && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return s;
}

// Of what was just read, which parts the last capture already recorded.
// Two alignments, and the one that recognizes more wins:
//   scroll: the end of the previous tail == the start of this read (the whole
//           window moved up);
//   changed hunk: the common prefix + common suffix at the two ends; the middle
//           stretch is the new content (a longer tail, or a few redrawn lines in
//           the middle, both count).
// If neither end lines up (a one- or two-line coincidence doesn't count) the
// whole screen is taken as new: clear screen, switching programs and a full
// repaint all land here.
function dedup(prev, cur) {
  if (!prev.length || !cur.length) return { reuse: 0, fresh: cur };
  let reuse = 0, fresh = null;
  const k = longestShift(prev, cur);
  if (k >= 2 || (k > 0 && k === cur.length)) { reuse = k; fresh = cur.slice(k); }
  const p = commonPrefix(prev, cur);
  const s = commonSuffix(prev, cur, Math.min(prev.length, cur.length) - p);
  if (p + s > reuse) { reuse = p + s; fresh = cur.slice(p, cur.length - s); }
  return fresh ? { reuse, fresh } : { reuse: 0, fresh: cur };
}

// Keep only the trailing lines that fit within limit bytes.
function tailWithin(lines, limit) {
  let bytes = 0, from = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = byteLen(lines[i]) + (from === lines.length ? 0 : 1);
    if (bytes + size > limit) break;
    bytes += size; from = i;
  }
  return { kept: lines.slice(from), dropped: from };
}

export default class ConvoLog extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.state = { auto: false, last: {}, totals: {} };
    this.busy = {}; // address -> capture in flight
    this.all = false; // "capture all" running
    this.ready = false;
    this.err = null;
    this.text = null; // reader: whole file text
    this.whole = false; // reader: all / last 400 lines
    if (p.file) {
      cx.spawn(async (cx) => {
        try { this.text = await fs.readFile(p.file, "utf8"); this.err = null; }
        catch (e) { this.text = null; this.err = String(e?.message ?? e); }
        cx.notify();
      });
      return;
    }
    cx.spawn(async (cx) => { await this.load(); cx.notify(); });
    cx.timer.every(AUTO_MS, (cx) => {
      if (!this.state.auto) return;
      if (!agents().some((a) => a.status !== "idle")) return;
      this.captureAll(cx);
    });
  }

  async load() {
    try { await fs.mkdir(dir(), { recursive: true }); } catch (e) { this.err = `cannot create ${dir()}: ${String(e?.message ?? e)}`; }
    const raw = await fs.readFile(statePath(), "utf8").catch(() => null);
    if (raw) {
      try {
        const s = JSON.parse(raw);
        this.state = {
          auto: s?.auto === true,
          last: s?.last && typeof s.last === "object" ? s.last : {},
          totals: s?.totals && typeof s.totals === "object" ? s.totals : {},
        };
      } catch (e) { this.err = `state.json unreadable: ${String(e?.message ?? e)}`; }
    }
    // Log present but bookkeeping missing or out of step (state.json deleted by
    // hand, a previous write failed): recount from the files. Look at the agents
    // alive now, and at the addresses left in the bookkeeping.
    const known = new Set([...Object.keys(this.state.last), ...Object.keys(this.state.totals), ...agents().map((a) => a.address)]);
    for (const address of known) {
      const path = logPath(address);
      if (!await fs.exists(path)) continue;
      const text = await fs.readFile(path, "utf8").catch(() => "");
      this.state.totals[address] = { lines: countLines(text), bytes: byteLen(text) };
    }
    this.ready = true;
  }

  async save() {
    try { await fs.writeFile(statePath(), `${JSON.stringify(this.state, null, 2)}\n`); }
    catch (e) { this.err = `state.json not writable: ${String(e?.message ?? e)}`; }
  }

  // One capture: read the screen, align it with the previous tail, and append
  // only the new part to the log.
  async run(address) {
    const a = agents().find((x) => x.address === address);
    const status = a?.status ?? "unknown";
    const r = await hc(["read", address, "--lines", String(LINES_READ)]);
    if (r.code !== 0) throw new Error((r.stderr || `hc read ${address} failed`).trim());
    const lines = splitLines(r.stdout);
    const prev = this.state.last[address]?.lines ?? [];
    const { reuse, fresh } = dedup(prev, lines);
    const at = Date.now();
    if (fresh.length) {
      const head = `\n===== ${stamp(at)} · ${status} =====\n`;
      const room = MAX_BLOCK - byteLen(head);
      let { kept, dropped } = tailWithin(fresh, room);
      let mark = dropped ? `... first ${dropped} lines of this capture exceeded 8 kB and were not recorded\n` : "";
      if (mark) {
        const again = tailWithin(kept, room - byteLen(mark));
        dropped += again.dropped; kept = again.kept;
        mark = `... first ${dropped} lines of this capture exceeded 8 kB and were not recorded\n`;
      }
      const block = `${head}${mark}${kept.join("\n")}\n`;
      const path = logPath(address);
      await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      const old = await fs.readFile(path, "utf8").catch(() => "");
      await fs.writeFile(path, old + block);
      const after = old + block;
      this.state.totals[address] = { lines: countLines(after), bytes: byteLen(after) };
    }
    this.state.last[address] = { hash: digest(lines.join("\n")), lines: lines.slice(-KEEP_LINES), at };
    await this.save();
    return { address, status, at, read: lines.length, added: fresh.length, reused: reuse };
  }

  capture(address, cx) {
    if (this.busy[address]) return;
    this.busy[address] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await this.run(address); }
      catch (e) { this.err = `capture ${address}: ${String(e?.message ?? e)}`; }
      finally { this.busy[address] = false; cx.notify(); }
    });
  }

  // Capture every agent in turn.
  captureAll(cx) {
    if (this.all) return;
    this.all = true;
    cx.notify();
    cx.spawn(async (cx) => {
      for (const a of agents()) {
        this.busy[a.address] = true;
        cx.notify();
        try { await this.run(a.address); }
        catch (e) { this.err = `capture ${a.address}: ${String(e?.message ?? e)}`; }
        finally { this.busy[a.address] = false; cx.notify(); }
      }
      this.all = false;
      cx.notify();
    });
  }

  clear(address, cx) {
    this.busy[address] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(dir() + "/" + machineOf(address), { recursive: true });
        await fs.writeFile(logPath(address), "");
      } catch (e) { this.err = `clear ${address}: ${String(e?.message ?? e)}`; }
      this.state.totals[address] = { lines: 0, bytes: 0 };
      delete this.state.last[address];
      await this.save();
      this.busy[address] = false;
      cx.notify();
    });
  }

  folder(address) {
    return panes().find((p) => p.terminal === address)?.cwd ?? "";
  }

  button(t, id, label, onClick) {
    return div().id(id).px(8).py(2).rounded(5).flex_none().text_size(11.5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
  }

  spinner(t) {
    return div().px(8).py(2).flex_none().child(svg(SPINNER).size(12).text_color(t.working).spin(900));
  }

  dot(t, status) {
    if (status === "working") return svg(SPINNER).size(12).flex_none().text_color(t.working).spin(900);
    if (status === "idle") return div().size(8).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(8).flex_none().rounded(4).bg(t[status] ?? t.dim);
  }

  row(a, t) {
    const tot = this.state.totals[a.address];
    const last = this.state.last[a.address];
    const on = a.status !== "idle";
    return v_flex().id(`row-${a.address}`).flex_none().px(8).py(6).gap(3).rounded(8)
      .when(a.focused, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(h_flex().gap(7).items_center()
        .child(this.dot(t, a.status))
        .child(div().w(52).flex_none().truncate().text_size(11.5).text_color(t[a.status] ?? t.dim).child(WORDS[a.status] ?? a.status))
        .child(div().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(a.program?.name ?? "program"))
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(a.address))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
          .child(`${a.space_name || a.space} · ${a.tab_name || a.tab}`))
        .child(this.busy[a.address] ? this.spinner(t) : this.button(t, `cap-${a.address}`, "capture", (_e, cx) => this.capture(a.address, cx)))
        .child(this.button(t, `see-${a.address}`, "view", () => this.openReader(a)))
        .child(this.button(t, `clr-${a.address}`, "clear", (_e, cx) => this.clear(a.address, cx))))
      .child(h_flex().gap(7).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.folder(a.address) || "—"))
        .child(div().flex_none().text_size(11).text_color(t.dim)
          .child(`${num(tot?.lines)} lines · ${num(tot?.bytes)} B`))
        .child(div().flex_none().text_size(11).text_color(on ? t.muted : t.dim).child(last?.at ? clock(last.at) : "not captured")));
  }

  openReader(a) {
    openOverlay({
      mod: "convo-log",
      props: { file: logPath(a.address), title: `${a.program?.name ?? "program"} ${a.address}` },
      kind: "window",
      width: 780,
      height: 620,
      key: a.address,
      keep: false,
    });
  }

  recorder(cx) {
    const t = theme();
    const list = agents();
    return v_flex().id("convo-log").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().font_semibold().child("Conversation log"))
        .child(div().flex_1().min_w(0))
        .when(this.all, (el) => el.child(this.spinner(t)))
        .child(this.button(t, "all", "capture all", (_e, cx) => this.captureAll(cx)))
        .child(h_flex().gap(5).items_center()
          .child(Switch.new("auto").checked(this.state.auto).on_change((v, cx) => { this.state.auto = v; this.save(); cx.notify(); })
            .w(30).h(17).rounded(9).p(2).bg(this.state.auto ? t.accent : t.border)
            .child(h_flex().size_full().items_center().when(this.state.auto, (el) => el.justify_end())
              .child(div().size(11).rounded(6).bg(this.state.auto ? t.accent_foreground ?? t.foreground : t.muted))))
          .child(div().text_size(11.5).text_color(this.state.auto ? t.foreground : t.muted).child("auto")))
        .child(this.button(t, "dir", "open folder", () => exec("explorer", [dir().replace(/\//g, "\\")]))))
      .child(v_flex().id("convo-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .children(list.map((a) => this.row(a, t)))
        .when(!list.length, (el) => el.child(div().p(10).text_color(t.dim).child(this.ready ? "no agent terminals" : "reading...")))
        .when(Boolean(this.err), (el) => el.child(div().p(10).text_color(t.blocked).child(this.err))));
  }

  reader() {
    const t = theme();
    const p = props() ?? {};
    const text = this.text ?? "";
    const name = String(p.file ?? "").split(/[\\/]/).pop();
    const all = text ? splitLines(text) : [];
    const shown = this.whole ? all : all.slice(-TAIL_LINES);
    const mono = settings()?.font;
    return v_flex().id("convo-reader").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(12)
      .child(h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().font_semibold().child(String(p.title ?? name ?? "Conversation log")))
        .child(div().flex_none().text_size(11).text_color(t.dim)
          .child(`${name ?? ""} · ${num(byteLen(text))} B · ${num(shown.length)} lines${this.whole ? "" : ` (of ${num(all.length)})`}`))
        .child(div().flex_1().min_w(0))
        .child(this.button(t, "tail", this.whole ? "last 400 lines" : "all", (_e, cx) => { this.whole = !this.whole; cx.notify(); }))
        .child(this.button(t, "reload", "refresh", (_e, cx) => this.reload(cx)))
        .child(this.button(t, "close", "✕", () => closeOverlay(p.overlay))))
      .child(v_flex().id("convo-text").flex_1().min_h(0).overflow_y_scrollbar().py(6)
        .when(Boolean(this.err), (el) => el.child(div().px(12).py(6).text_color(t.blocked).child(this.err)))
        .when(!this.err && !text, (el) => el.child(div().px(12).py(6).text_color(t.dim).child("reading...")))
        .when(Boolean(text) && !shown.length, (el) => el.child(div().px(12).py(6).text_color(t.dim).child("log is empty")))
        .children(shown.map((line, i) => div().id(`log-${i}`).w_full().px(12).whitespace_normal()
          .when(Boolean(mono), (el) => el.font_family(mono)).text_size(12)
          .text_color(line.startsWith("=====") ? t.accent : t.foreground)
          .child(line === "" ? " " : line))));
  }

  reload(cx) {
    const file = props()?.file;
    if (!file) return;
    cx.spawn(async (cx) => {
      try { this.text = await fs.readFile(file, "utf8"); this.err = null; }
      catch (e) { this.err = String(e?.message ?? e); }
      cx.notify();
    });
  }

  render() {
    return props()?.file ? this.reader() : this.recorder();
  }
}
