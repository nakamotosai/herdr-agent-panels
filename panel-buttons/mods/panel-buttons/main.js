// Panel buttons: three toggles for docked panels in the Herdr desktop app.
//
// Put it where a mod fits: as a block in your top strip (in the same row as the shipped
// `tabs` block), as a block beside another panel, or as a floating block on an edge.
// Each button shows its panel in a stack; pressing the button of the panel already showing
// collapses the whole column, so one press opens and the next press closes.
//
// props (all optional):
//   panel: the id of the docked column to show/hide          (default "sai-panel")
//   body:  the id of the stack inside it, one child at a time (default "sai-panel-body")
//   items: [{ child: "<layout node id>", label: "<button text>" }]
//          (defaults to the three panels of this repo)
//
// A layout that has no such column (or a machine without the panels) falls back to opening
// the mod as its own overlay, so a button is never dead.
//
// Which panel shows is tracked here (shared "panel-buttons.<panel>"), seeded once from the
// app's own click record (layouts/.state/<layout>.json), because layout() returns the layout
// file, in which a stack's clicked child does not appear.

import { View } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, layout, readTextFile, run, setShared, shared, theme, props } from "herdr";

const DEFAULTS = {
  panel: "sai-panel",
  body: "sai-panel-body",
  items: [
    { child: "token-usage", label: "Usage" },
    { child: "convo-log", label: "Log" },
    { child: "task-sched", label: "Cron" },
  ],
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class PanelButtons extends View {
  ids() {
    const p = props() ?? {};
    return {
      panel: p.panel ?? DEFAULTS.panel,
      body: p.body ?? DEFAULTS.body,
      items: Array.isArray(p.items) && p.items.length ? p.items : DEFAULTS.items,
    };
  }

  key() {
    return `panel-buttons.${this.ids().panel}`;
  }

  current() {
    const s = shared(this.key());
    if (!s || typeof s !== "object" || typeof s.child !== "string") return null;
    const { panel, body } = this.ids();
    return { panel, body, child: s.child, shown: s.shown !== false };
  }

  /** The app's own record of what is showing, before the first press of a button. */
  async readState() {
    const name = shared("layout");
    if (typeof name !== "string" || !name) return null;
    const text = await readTextFile(`${appHome()}/layouts/.state/${name}.json`);
    if (!text) return null;
    const { panel, body } = this.ids();
    try {
      const nodes = JSON.parse(text)?.nodes ?? {};
      const child = nodes[body]?.active;
      if (typeof child !== "string") return null;
      return { panel, body, child, shown: nodes[panel]?.hidden !== true };
    } catch {
      return null;
    }
  }

  init(_props, cx) {
    if (this.current()) return;
    cx.spawn(async (cx) => {
      const s = await this.readState();
      if (s) setShared(this.key(), s);
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const { panel: panelId, body: bodyId, items } = this.ids();
    const root = layout();
    const panel = find(root, panelId);
    const body = find(root, bodyId);
    const state = this.current() ?? { panel: panelId, body: bodyId, child: items[0].child, shown: true };
    // A top strip usually drags the window; a button's own press must not start that.
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex()
      .gap(3)
      .flex_none()
      .items_center()
      .children(
        items.map((it) => {
          const on = state.shown && state.child === it.child;
          return h_flex()
            .id(`panel-buttons-${it.child}`)
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
              if (!panel || !body) {
                run("mod.open", { name: it.child });
              } else if (on) {
                setShared(this.key(), { ...state, shown: false });
                run("layout.hide", { id: panelId });
              } else {
                setShared(this.key(), { ...state, shown: true, child: it.child });
                // A stack child that was switched away stays hidden in the app's click
                // record, so showing a panel means showing its child as well as the column.
                run("layout.select", { stack: bodyId, child: it.child });
                run("layout.show", { id: it.child });
                run("layout.show", { id: panelId });
              }
            })
            .child(it.label);
        }),
      );
  }
}
