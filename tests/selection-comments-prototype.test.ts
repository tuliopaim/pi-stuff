import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "../agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import {
  CURSOR_MARKER,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type TUI,
} from "../agent/node_modules/@earendil-works/pi-tui/dist/index.js";
import {
  CommentDialog,
  SelectionComments,
  commentPrompt,
} from "../agent/extensions/selection-comments-prototype.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  getBgAnsi: () => "",
} as unknown as Theme;

class TestTerminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void) { this.input = onInput; }
  stop() {}
  async drainInput() {}
  write() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

function harness(options: { busy?: boolean; failSend?: boolean } = {}) {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  const sent: { content: string; options: unknown }[] = [];
  const notices: string[] = [];
  const mainInput: string[] = [];
  let draft = "Existing unsent prompt";
  let dialog: Component | undefined;
  let dialogHandle: OverlayHandle | undefined;
  const ctx = {
    mode: "tui",
    isIdle: () => !options.busy,
    ui: {
      notify: (message: string) => notices.push(message),
      pasteToEditor: (text: string) => { draft += text; },
      custom: (factory: (tui: TUI, theme: Theme, kb: unknown, done: (value: string | undefined) => void) => Component,
        settings: { overlayOptions: object }) => new Promise<string | undefined>((resolve) => {
          let closed = false;
          dialog = factory(tui, theme, {}, (value) => {
            if (closed) return;
            closed = true;
            dialogHandle?.hide();
            dialog = undefined;
            resolve(value);
          });
          dialogHandle = tui.showOverlay(dialog, settings.overlayOptions);
        }),
    },
  } as unknown as ExtensionContext;
  const controller = new SelectionComments(tui, ctx, {
    sendUserMessage(content, sendOptions) {
      if (options.failSend) throw new Error("Delivery unavailable");
      assert.equal(typeof content, "string");
      sent.push({ content: content as string, options: sendOptions });
    },
  }, theme);
  tui.addChild(new Text("alpha beta\nsecond line", 0, 0));
  tui.addChild(controller);
  const main: Component = {
    render: () => [],
    invalidate() {},
    handleInput: (data) => mainInput.push(data),
  };
  tui.setFocus(main);
  tui.start();
  tui.renderNow();

  const mouse = (button: number, x: number, y: number, release = false) =>
    terminal.input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  const select = (fromX = 0, fromY = 0, toX = 4, toY = 0) => {
    mouse(0, fromX, fromY);
    mouse(32, toX, toY);
    mouse(0, toX, toY, true);
    tui.renderNow();
  };
  const click = (x: number, y: number) => {
    mouse(0, x, y);
    mouse(0, x, y, true);
    tui.renderNow();
  };
  return {
    tui, terminal, controller, ctx, sent, notices, mainInput, select, click,
    get dialog() { return dialog; },
    get draft() { return draft; },
    close() { controller.dispose(); tui.stop(); },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test("selecting shows a clickable Cite without sending or taking keyboard focus", async () => {
  const h = harness();
  try {
    h.select();
    assert.equal(h.sent.length, 0);
    assert.ok(h.tui.getScreenLines()[0].includes("Cite"));
    h.click(5, 0);
    assert.ok(h.dialog instanceof CommentDialog);
    h.terminal.input("Please explain this");
    h.terminal.input("\x1b[13;5u");
    await flush();
    assert.deepEqual(h.sent, [{
      content: commentPrompt("alpha", "Please explain this"),
      options: { deliverAs: "followUp" },
    }]);
    assert.equal(h.draft, "Existing unsent prompt");
    assert.equal(h.tui.hasOverlay(), false);
  } finally { h.close(); }
});

test("Escape dismisses Cite without reaching the agent's interrupt key", () => {
  const h = harness();
  try {
    h.select();
    h.terminal.input("\x1b");
    assert.equal(h.tui.hasOverlay(), false);
    assert.deepEqual(h.mainInput, []);
    h.select();
    h.terminal.input("x");
    assert.equal(h.tui.hasOverlay(), false);
    assert.deepEqual(h.mainInput, ["x"]);
    assert.equal(h.sent.length, 0);
  } finally { h.close(); }
});

test("a new selection replaces the quote; multiline reverse selections stay intact", async () => {
  const h = harness();
  try {
    h.select();
    h.select(5, 1, 6, 0);
    assert.equal((h.tui as unknown as { getActiveSelectionText(): string }).getActiveSelectionText(), "beta\nsecond");
    const pending = h.controller.openComment();
    h.terminal.input("Change only this passage");
    h.terminal.input("\r");
    await pending;
    assert.equal(h.sent[0].content, commentPrompt("beta\nsecond", "Change only this passage"));
  } finally { h.close(); }
});

test("a blank comment cannot send, Shift+Enter adds a newline, and Cancel sends nothing", async () => {
  const h = harness();
  try {
    h.select();
    const pending = h.controller.openComment();
    h.tui.renderNow();
    h.terminal.input("\r");
    assert.equal(h.sent.length, 0);
    assert.ok(h.dialog);
    h.terminal.input("first");
    h.terminal.input("\x1b[13;2u");
    h.terminal.input("second");
    assert.equal((h.dialog as CommentDialog).editor.getExpandedText(), "first\nsecond");
    h.terminal.input("\x1b");
    await pending;
    assert.equal(h.sent.length, 0);
    assert.equal(h.draft, "Existing unsent prompt");
  } finally { h.close(); }
});

test("Send and Cancel work with the mouse, and busy-agent delivery is a follow-up", async () => {
  for (const send of [false, true]) {
    const h = harness({ busy: true });
    try {
      h.select();
      const pending = h.controller.openComment();
      h.tui.renderNow();
      h.terminal.input("Keep this comment");
      h.tui.renderNow();
      const lines = h.tui.getScreenLines().map(stripTerminalSequences);
      const y = lines.findIndex((line) => line.includes("Cancel"));
      assert.notEqual(y, -1);
      const x = lines[y].indexOf(send ? "Send" : "Cancel");
      h.click(x + 1, y);
      await pending;
      assert.equal(h.sent.length, send ? 1 : 0);
      if (send) assert.deepEqual(h.sent[0].options, { deliverAs: "followUp" });
    } finally { h.close(); }
  }
});

test("disposal cancels an open comment and restores Pi's private handler", async () => {
  const h = harness();
  try {
    h.select();
    const pending = h.controller.openComment();
    h.terminal.input("Do not send to another session");
    h.controller.dispose();
    await pending;
    assert.equal(h.sent.length, 0);
    assert.equal(h.tui.hasOverlay(), false);
    assert.equal((h.tui as unknown as { handleViewportInput: unknown }).handleViewportInput,
      Object.getPrototypeOf(h.tui).handleViewportInput);
    h.controller.dispose();
  } finally { h.close(); }
});

test("delivery failure keeps the quote and comment alongside the main-editor draft", async () => {
  const h = harness({ failSend: true });
  try {
    h.select();
    const pending = h.controller.openComment();
    h.terminal.input("A comment worth keeping");
    h.terminal.input("\r");
    await pending;
    assert.equal(h.draft, `Existing unsent prompt\n\n${commentPrompt("alpha", "A comment worth keeping")}`);
    assert.ok(h.notices.some((notice) => notice.includes("Comment kept")));
  } finally { h.close(); }
});

test("dialog lines fit narrow terminals and preserve expanded pastes", () => {
  const h = harness();
  try {
    const dialog = new CommentDialog(h.tui, theme, "中文 🙂 quoted text\nanother line", () => {});
    dialog.editor.handleInput("\x1b[200~" + "pasted comment\n".repeat(15) + "\x1b[201~");
    assert.ok(dialog.editor.getExpandedText().includes("pasted comment\n".repeat(14)));
    for (const width of [8, 18, 40, 64]) {
      for (const line of dialog.render(width)) assert.ok(visibleWidth(line) <= width);
    }
    dialog.invalidate();
  } finally { h.close(); }
});

test("the compact card keeps its frame, placeholder, and editor mouse positions aligned", async () => {
  const h = harness();
  try {
    h.select();
    const pending = h.controller.openComment();
    h.tui.renderNow();
    const dialog = h.dialog as CommentDialog;
    const card = dialog.render(52).map(stripTerminalSequences);
    assert.equal(card.length, 7);
    assert.ok(card[0].startsWith("╭─ Comment "));
    assert.ok(card[1].includes("▎ alpha"));
    assert.ok(card[3].includes("Add a comment…"));
    assert.ok(card[5].includes("Cancel   Send ↵"));
    assert.ok(card.at(-1)?.startsWith("╰"));
    assert.ok(card.every((line) => visibleWidth(line) === 52));
    assert.equal(dialog.render(52).join("").split(CURSOR_MARKER).length - 1, 1);
    h.terminal.input("first second");
    h.tui.renderNow();
    const screen = h.tui.getScreenLines().map(stripTerminalSequences);
    const y = screen.findIndex((line) => line.includes("first second"));
    h.click(screen[y].indexOf("first second") + 5, y);
    h.terminal.input(" edited");
    assert.equal(dialog.editor.getExpandedText(), "first edited second");
    assert.ok(dialog.focused);
    h.terminal.input("\x1b");
    await pending;
    assert.equal(h.sent.length, 0);
  } finally { h.close(); }
});

test("the card keeps a neutral background after cursor and button resets", () => {
  const h = harness();
  try {
    const bg = "\x1b[48;5;236m";
    const selected = "\x1b[44m";
    const coloredTheme = {
      ...theme,
      getBgAnsi: () => bg,
      bg: (color: string, text: string) => `${color === "selectedBg" ? selected : bg}${text}\x1b[49m`,
    } as unknown as Theme;
    const dialog = new CommentDialog(h.tui, coloredTheme, "Some quoted text", () => {});
    dialog.focused = true;
    assert.ok(dialog.render(52)[3].includes(`\x1b[0m${bg}`));
    assert.ok(!dialog.render(52).at(-2)?.includes(selected));
    dialog.editor.setText("Ready to send");
    assert.ok(dialog.render(52).at(-2)?.includes(selected));
    assert.ok(dialog.render(52).at(-2)?.includes(`\x1b[49m${bg}`));
  } finally { h.close(); }
});

test("regular mode and missing private APIs fail safely without replacing Pi's handler", async () => {
  const h = harness();
  h.controller.dispose();
  const regular = new SelectionComments(new TuiMainScreen(new TestTerminal()), h.ctx, { sendUserMessage() {} }, theme);
  const unsupported = new Proxy(h.tui, {
    get: (target, property, receiver) => property === "getActiveSelectionText"
      ? undefined : Reflect.get(target, property, receiver),
  });
  const guarded = new SelectionComments(unsupported, h.ctx, { sendUserMessage() {} }, theme);
  try {
    await regular.openComment();
    guarded.render();
    assert.ok(h.notices.some((notice) => notice.includes("fullscreen mode")));
    assert.equal(h.notices.filter((notice) => notice.includes("different selection internals")).length, 1);
    assert.equal((h.tui as unknown as { handleViewportInput: unknown }).handleViewportInput,
      Object.getPrototypeOf(h.tui).handleViewportInput);
  } finally { regular.dispose(); guarded.dispose(); h.close(); }
});

test("a stable forwarding TUI proxy can switch renderer modes without recursive hooks", () => {
  const h = harness();
  h.controller.dispose();
  let renderer: TUI = h.tui;
  const proxy = new Proxy({} as TUI, {
    get: (_target, property) => {
      const value = Reflect.get(renderer, property, renderer);
      return typeof value === "function" ? (...args: unknown[]) =>
        Reflect.apply(value, renderer, args) : value;
    },
    set: (_target, property, value) => Reflect.set(renderer, property, value, renderer),
    getPrototypeOf: () => Reflect.getPrototypeOf(renderer),
  });
  const controller = new SelectionComments(proxy, h.ctx, { sendUserMessage() {} }, theme);
  try {
    h.select();
    controller.dispose();
    assert.equal((h.tui as unknown as { handleViewportInput: unknown }).handleViewportInput,
      Object.getPrototypeOf(h.tui).handleViewportInput);
  } finally { controller.dispose(); h.close(); }
  const regular = new TuiMainScreen(new TestTerminal());
  const swapped = new SelectionComments(proxy, h.ctx, { sendUserMessage() {} }, theme);
  try {
    renderer = regular;
    swapped.render();
    renderer = h.tui;
    swapped.render();
    assert.equal(typeof (h.tui as unknown as { handleViewportInput: unknown }).handleViewportInput, "function");
  } finally { swapped.dispose(); }
});
