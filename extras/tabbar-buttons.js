// Added for sai: three buttons in the tab bar's right cluster. One docked panel area
// (layouts/dashboard.json: the column "sai-panel" holding the stack "sai-panel-body")
// shows token-usage / convo-log / task-sched one at a time; a button shows its panel and
// the button of the panel already showing collapses the whole column again.
//
// Installed by three hooks in main.js:
//   import { seedButtons, quickButtons } from "./quick-buttons.js";     (top)
//   seedButtons(cx)                                                     (in init)
//   .child(quickButtons())                                              (after the Changes button)
//
// Herdr updates its own mods/tabs; mods/tabs-sai is a clone of it and is never updated.
// To re-apply this after an upstream tab-bar change:
//   1. herdr-app do mod.clone --name tabs --as tabs-sai2   (or delete tabs-sai and re-clone)
//   2. copy this file into the new folder and re-add the three lines above
//   3. point the layout's tabs block at the new mod (layouts/dashboard.json, "mod": "tabs-sai")
//
// Which panel shows is tracked here (shared "tabbar-panels"), seeded once from the app's own
// click record (layouts/.state/<layout>.json), because layout() returns the layout file, in
// which a stack's clicked child does not appear.

import { h_flex } from "gpui-base";
import { appHome, readTextFile, run, setShared, shared, theme } from "herdr";

const KEY = "tabbar-panels"; // { panel, body, child, shown }
const PANEL = "sai-panel"; // the docked column
const BODY = "sai-panel-body"; // its stack, one child shown
const BUTTONS = [
  { id: "token-usage", label: "Usage" },
  { id: "convo-log", label: "Log" },
  { id: "task-sched", label: "Cron" },
];
const FALLBACK = { panel: PANEL, body: BODY, child: BUTTONS[0].id, shown: true };

let seeding = false;

function current() {
  const s = shared(KEY);
  if (!s || typeof s !== "object" || typeof s.child !== "string") return null;
  return { panel: s.panel ?? PANEL, body: s.body ?? BODY, child: s.child, shown: s.shown !== false };
}

/** The app's own record of what is showing, before the first press of a button. */
async function readState() {
  const name = shared("layout");
  if (typeof name !== "string" || !name) return null;
  const text = await readTextFile(`${appHome()}/layouts/.state/${name}.json`);
  if (!text) return null;
  try {
    const nodes = JSON.parse(text)?.nodes ?? {};
    const child = nodes[BODY]?.active;
    if (typeof child !== "string") return null;
    return { panel: PANEL, body: BODY, child, shown: nodes[PANEL]?.hidden !== true };
  } catch {
    return null;
  }
}

/** Ask the app once, from init, so the first render's highlight is the truth. */
export function seedButtons(cx) {
  if (current() || seeding) return;
  seeding = true;
  cx.spawn(async (cx) => {
    try {
      const s = await readState();
      if (s) setShared(KEY, s);
    } finally {
      seeding = false;
      cx.notify();
    }
  });
}

export function quickButtons() {
  const t = theme();
  const state = current() ?? FALLBACK;
  // The bar drags the window; a button's own press must not start that.
  const stop = (_e, cx) => cx.stop_propagation();
  return h_flex()
    .gap(3)
    .flex_none()
    .items_center()
    .children(
      BUTTONS.map((b) => {
        const on = state.shown && state.child === b.id;
        return h_flex()
          .id(`quick-${b.id}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .rounded(6)
          .text_size(12)
          .bg(on ? t.selected : t.chrome)
          .text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop)
          .on_click(() => {
            if (on) {
              setShared(KEY, { ...state, shown: false });
              run("layout.hide", { id: state.panel });
            } else {
              setShared(KEY, { ...state, shown: true, child: b.id });
              // A stack child that was switched away stays hidden in the app's click
              // record, so showing a panel means showing its child as well as the column.
              run("layout.select", { stack: state.body, child: b.id });
              run("layout.show", { id: b.id });
              run("layout.show", { id: state.panel });
            }
          })
          .child(b.label);
      }),
    );
}
