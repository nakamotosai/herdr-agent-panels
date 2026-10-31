// Task scheduler: while this window is open, run agent tasks on their own interval.
// Tasks live in data/task-sched/tasks.json, every fire appends to data/task-sched/runs.log.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Button, Input, InputState } from "gpui-base";
import { theme, run, notify, readTextFile, writeTextFile, pickFolder, home, appHome, props, closeOverlay } from "herdr";
import * as fs from "fs/promises";

const SEED = [{
  id: "t1", label: "Daily summary", every: 60, folder: home(),
  argv: ["omp"], task: "Summarize today's work", enabled: false, lastRun: null, runs: 0,
}];

const pad = (n, w) => String(n).padStart(w, "0");
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`; };
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60), 2)}:${pad(s % 60, 2)}`; };

export default class TaskSched extends View {
  init(_props, cx) {
    this.dir = `${appHome()}/data/task-sched`;
    this.file = `${this.dir}/tasks.json`;
    this.log = `${this.dir}/runs.log`;
    this.tasks = [];
    this.lastText = null;
    this.logText = "";
    this.today = 0;
    this.sessionRuns = 0;
    this.fired = {};
    this.startedAt = Date.now();
    this.now = Date.now();
    this.form = false;
    this.field = null;
    this.error = null;
    this.loaded = false;
    this.saving = false;
    this.again = false;

    this.iName = InputState.new({ placeholder: "Daily summary" });
    this.iFolder = InputState.new({ placeholder: home() });
    this.iArgv = InputState.new({ placeholder: "omp" });
    this.iTask = InputState.new({ placeholder: "optional: first message the agent gets" });
    this.iEvery = InputState.new({ placeholder: "60", value: "60" });
    for (const [key, state] of [["name", this.iName], ["folder", this.iFolder], ["argv", this.iArgv], ["task", this.iTask], ["every", this.iEvery]]) {
      state.on("change", (_e, cx) => cx.notify());
      state.on("focus", (_e, cx) => { this.field = key; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.field === key) { this.field = null; cx.notify(); } });
    }

    cx.spawn(async (cx) => { try { await this.load(); } catch (e) { this.error = String(e); } cx.notify(); });
    // One tick does both jobs: it fires what is due and refreshes the countdown/last-run display,
    // so no timer redraws the window faster than this. Countdown resolution is therefore 15 s.
    cx.timer.every(15000, (cx) => this.tick(cx));
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    let text = await readTextFile(this.file);
    if (text === null) {
      text = `${JSON.stringify(SEED, null, 2)}\n`;
      await writeTextFile(this.file, text, null);
    }
    this.adopt(text);
    this.logText = (await readTextFile(this.log)) ?? "";
    this.today = this.countToday();
    this.loaded = true;
  }

  adopt(text) {
    this.lastText = text;
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : [];
      this.tasks = list.filter((t) => t && typeof t === "object" && typeof t.id === "string" && typeof t.label === "string")
        .map((t) => ({
          ...t,
          label: String(t.label),
          every: Number(t.every) || 1,
          folder: typeof t.folder === "string" ? t.folder : "",
          argv: Array.isArray(t.argv) ? t.argv.map(String) : [],
          task: typeof t.task === "string" ? t.task : "",
          enabled: t.enabled !== false,
          lastRun: typeof t.lastRun === "number" ? t.lastRun : null,
          runs: Number(t.runs) || 0,
        }));
      if (this.error === "tasks.json is not valid JSON") this.error = null;
    } catch {
      this.error = "tasks.json is not valid JSON";
    }
  }

  countToday() {
    const key = day(Date.now());
    let n = 0;
    for (const line of this.logText.split("\n")) {
      if (!line) continue;
      const ms = Date.parse(line.split("\t")[0]);
      if (!Number.isNaN(ms) && day(ms) === key) n += 1;
    }
    return n;
  }

  // Picks up a hand-edited tasks.json (or another copy's writes) without fighting our own saves.
  async reload() {
    if (this.saving) return;
    const text = await readTextFile(this.file).catch(() => null);
    if (text !== null && text !== this.lastText) {
      this.adopt(text);
      this.logText = (await readTextFile(this.log)) ?? this.logText;
      this.today = this.countToday();
    }
  }

  async save() {
    if (this.saving) { this.again = true; return; }
    this.saving = true;
    try {
      do {
        this.again = false;
        const text = `${JSON.stringify(this.tasks, null, 2)}\n`;
        for (let attempt = 0; attempt < 4; attempt++) {
          const current = await readTextFile(this.file).catch(() => null);
          try {
            await writeTextFile(this.file, text, current);
            this.lastText = text;
            this.error = null;
            break;
          } catch (e) {
            this.error = `Could not write tasks.json: ${String(e)}`;
          }
        }
      } while (this.again);
    } finally {
      this.saving = false;
    }
  }

  due(task, now) {
    if (!task.enabled) return false;
    if (this.fired[task.id] === Math.floor(now / 60000)) return false;
    const every = Math.max(1, Number(task.every) || 1);
    return task.lastRun == null || now - task.lastRun >= every * 60000;
  }

  tick(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.reload();
        const now = Date.now();
        this.now = now;
        const task = this.tasks.find((t) => this.due(t, now));
        if (task) await this.fire(task, now, cx);
      } catch (e) {
        this.error = String(e);
      }
      cx.notify();
    });
  }

  async appendLog(task, now) {
    const line = `${new Date(now).toISOString()}\t${task.label}\t${task.folder}\t${task.argv.join(" ")}`;
    const current = await readTextFile(this.log).catch(() => null);
    const base = current ?? "";
    const text = `${base}${base && !base.endsWith("\n") ? "\n" : ""}${line}\n`;
    this.logText = text;
    this.today += 1;
    try {
      await writeTextFile(this.log, text, current);
    } catch (e) {
      this.error = `Could not write runs.log: ${String(e)}`;
    }
  }

  async fire(task, now, cx) {
    this.fired[task.id] = Math.floor(now / 60000);
    const args = { name: task.label };
    if (task.folder) args.folder = task.folder;
    if (task.argv.length) args.argv = task.argv;
    if (task.task) args.task = task.task;
    run("tab.new", args);
    task.lastRun = now;
    task.runs += 1;
    this.sessionRuns += 1;
    await this.appendLog(task, now);
    await this.save();
    notify({ title: "Scheduled task started", body: task.label });
    cx.notify();
  }

  manual(task, cx) {
    cx.spawn(async (cx) => { try { await this.fire(task, Date.now(), cx); } catch (e) { this.error = String(e); cx.notify(); } });
  }

  toggle(task, cx) {
    task.enabled = !task.enabled;
    cx.notify();
    cx.spawn(async () => { await this.save(); });
  }

  remove(task, cx) {
    this.tasks = this.tasks.filter((x) => x !== task);
    delete this.fired[task.id];
    cx.notify();
    cx.spawn(async () => { await this.save(); });
  }

  pick(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Use this folder" }).catch(() => null);
      if (folder) { this.iFolder.set_value(folder); cx.notify(); }
    });
  }

  submit(cx) {
    cx.spawn(async (cx) => {
      const label = this.iName.value().trim();
      const folder = this.iFolder.value().trim();
      const argv = this.iArgv.value().split(/[\s,]+/).filter(Boolean);
      const every = Number(this.iEvery.value().trim());
      const fail = (message) => { this.error = message; cx.notify(); };
      if (!label) return fail("Name is required");
      if (!(Number.isFinite(every) && every >= 1)) return fail("Interval must be at least 1 minute");
      if (!folder) return fail("Folder is required");
      if (!(await fs.exists(folder))) return fail(`Folder does not exist: ${folder}`);
      if (!argv.length) return fail("Command is required");
      this.tasks.push({
        id: `t${Date.now().toString(36)}`, label, every, folder, argv,
        task: this.iTask.value().trim(), enabled: true, lastRun: null, runs: 0,
      });
      this.error = null;
      this.form = false;
      this.iName.set_value(""); this.iFolder.set_value(""); this.iArgv.set_value("");
      this.iTask.set_value(""); this.iEvery.set_value("60");
      await this.save();
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const now = this.now;
    const on = this.tasks.filter((x) => x.enabled).length;
    const dim = t.dim;
    const button = (id, text, action, primary) => Button.new(id).h(24).px(9).rounded(6)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.muted).text_size(11.5).cursor_pointer().flex_none()
      .hover((s) => s.bg(primary ? t.solid : t.hover)).on_click(action).child(text);
    const input = (key, state, width) => {
      const box = Input.new(state).h(30).px(9).rounded(7).border_1()
        .border_color(this.field === key ? t.accent : t.input).bg(t.background)
        .text_size(12).text_color(t.foreground);
      return width ? box.w(width) : box.flex_1().min_w(0);
    };
    const field = (title, key, state, width) => v_flex().flex_1().min_w(0).gap(3)
      .child(div().text_size(11).text_color(dim).child(title))
      .child(input(key, state, width));

    const row = (task) => {
      const every = Math.max(1, task.every);
      const left = task.lastRun == null ? 0 : Math.max(0, task.lastRun + every * 60000 - now);
      const late = task.lastRun == null ? 0 : now - task.lastRun;
      const missed = late > 2 * every * 60000 ? Math.max(1, Math.floor(late / (every * 60000)) - 1) : 0;
      return v_flex().id(`ts-${task.id}`).flex_none().gap(3).p(9).rounded(8)
        .border_1().border_color(t.border).bg(t.raised)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(task.enabled ? t.foreground : dim).child(task.label))
          .child(button(`ts-run-${task.id}`, "Run now", (_e, cx) => this.manual(task, cx)))
          .child(button(`ts-tog-${task.id}`, task.enabled ? "Disable" : "Enable", (_e, cx) => this.toggle(task, cx)))
          .child(button(`ts-del-${task.id}`, "Delete", (_e, cx) => this.remove(task, cx))))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_size(11).text_color(dim).child(`every ${every} min`))
          .child(div().flex_none().text_size(11.5).text_color(task.enabled ? t.accent : dim).child(task.enabled ? mmss(left) : "disabled"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(dim).child(`last ${task.lastRun == null ? "never" : clock(task.lastRun)} · ${task.runs} runs`))
          .when(missed > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(`missed ${missed}`))))
        .child(div().min_w(0).truncate().text_size(11).text_color(dim).child(task.folder || "no folder set"))
        .child(div().min_w(0).truncate().text_size(11).text_color(dim)
          .child(`${task.argv.join(" ")}${task.task ? ` · ${task.task}` : ""}`));
    };

    return v_flex().id("task-sched").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(v_flex().flex_none().px(12).py(9).gap(3).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(13.5).font_semibold().child("Task scheduler"))
          .child(div().text_size(10).text_color(dim).child("v1"))
          .child(div().flex_1())
          .child(button("ts-new", this.form ? "Collapse" : "New", (_e, cx) => { this.form = !this.form; this.error = null; cx.notify(); }))
          .when(Boolean(props()?.overlay), (el) => el.child(button("ts-close", "✕", () => closeOverlay(props().overlay)))))
        .child(h_flex().items_center()
          .child(div().min_w(0).truncate().text_size(11).text_color(dim).child("Only fires while this window is open — close it and they stop")))
        .child(h_flex().items_center().justify_end()
          .child(div().flex_none().text_size(11).text_color(t.muted).child(`tasks ${this.tasks.length} · enabled ${on} · fired today ${this.today}`))))
      .when(this.form, (el) => el.child(v_flex().flex_none().gap(7).px(12).py(10).bg(t.chrome).border_b(1).border_color(t.border)
        .child(h_flex().gap(7)
          .child(field("Name", "name", this.iName))
          .child(field("Every (min)", "every", this.iEvery, 92)))
        .child(h_flex().gap(7).items_end()
          .child(field("Folder", "folder", this.iFolder))
          .child(button("ts-pick", "Browse", (_e, cx) => this.pick(cx))))
        .child(field("Command (space or comma separated)", "argv", this.iArgv))
        .child(field("First message (optional)", "task", this.iTask))
        .child(h_flex().gap(7).justify_end()
          .child(button("ts-cancel", "Cancel", (_e, cx) => { this.form = false; this.error = null; cx.notify(); }))
          .child(button("ts-save", "Save", (_e, cx) => this.submit(cx), true)))))
      .child(v_flex().id("ts-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(6)
        .children(this.tasks.map(row))
        .when(!this.tasks.length, (el) => el.child(div().p(10).text_size(12).text_color(dim)
          .child(this.loaded ? "No tasks yet — click New above to add one." : "Loading…"))))
      .child(h_flex().flex_none().px(12).h(28).gap(8).items_center().border_t(1).border_color(t.border).text_size(11).text_color(dim)
        .child(div().child(`this window has run ${this.sessionRuns} since ${clock(this.startedAt)}`))
        .child(div().flex_1())
        .when(Boolean(this.error), (el) => el.child(div().min_w(0).truncate().text_color(t.blocked).child(this.error)))
        .when(!this.error, (el) => el.child(div().min_w(0).truncate().child("data/task-sched/tasks.json"))));
  }
}
