// Added for sai: three buttons in the tab bar's right cluster. One docked panel area
// (layouts/dashboard.json: the column "sai-panel" holding the stack "sai-panel-body")
// shows token-usage / convo-log / task-sched one at a time; a button selects its panel
// and the panel area; the button of the panel that is open collapses it again.
//
// Installed by one hook in main.js:
//   import { quickButtons } from "./quick-buttons.js";   +   .child(quickButtons())
//
// Herdr updates its own mods/tabs; mods/tabs-sai is a clone of it and is never updated.
// To re-apply this after an upstream tab-bar change:
//   1. herdr-app do mod.clone --name tabs --as tabs-sai2   (or delete tabs-sai and re-clone)
//   2. copy this file into the new folder and re-add the two lines above (grep quickButtons)
//   3. point the layout's tabs block at the new mod (layouts/dashboard.json, "mod": "tabs-sai")

import { h_flex } from "gpui-base";
import { layout, run, theme } from "herdr";

const PANEL = "sai-panel"; // the docked column
const BODY = "sai-panel-body"; // its stack, one child shown

// Labels stay short: the bar is shared with tabs and the window buttons.
const BUTTONS = [
  { id: "token-usage", label: "Usage" },
  { id: "convo-log", label: "Log" },
  { id: "task-sched", label: "Cron" },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export function quickButtons() {
  const t = theme();
  const root = layout();
  const panel = find(root, PANEL);
  const body = find(root, BODY);
  const visible = Boolean(panel) && !panel.hidden;
  // The bar drags the window; a button's own press must not start that.
  const stop = (_e, cx) => cx.stop_propagation();
  return h_flex()
    .gap(3)
    .flex_none()
    .items_center()
    .children(
      BUTTONS.map((b) => {
        const on = visible && body?.active === b.id;
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
            // A layout that has no such panel (another layout using this bar) opens the
            // mod as its own overlay instead of doing nothing.
            if (!panel || !body) run("mod.open", { name: b.id });
            else if (on) run("layout.hide", { id: PANEL });
            else {
              run("layout.select", { stack: BODY, child: b.id });
              run("layout.show", { id: PANEL });
            }
          })
          .child(b.label);
      }),
    );
}
