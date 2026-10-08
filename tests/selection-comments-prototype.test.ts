import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "../agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
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
import selectionComments, {
  CommentDialog,
  SelectionComments,
  commentPrompt,
  commentsPrompt,
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

type StateEntry = { type: "custom"; customType: string; data: unknown };

function harness(options: { busy?: boolean; failSend?: boolean; entries?: StateEntry[]; failSave?: boolean } = {}) {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  const sent: { content: string; options: unknown }[] = [];
  const notices: string[] = [];
  const mainInput: string[] = [];
  const entries = options.entries ?? [];
  let draft = "Existing unsent prompt";
  let dialog: Component | undefined;
  let dialogHandle: OverlayHandle | undefined;
  const ctx = {
    mode: "tui",
    isIdle: () => !options.busy,
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (message: string) => notices.push(message),
      pasteToEditor: (text: string) => { draft += text; },
      custom: (factory: (tui: TUI, theme: Theme, kb: unknown, done: (value: unknown) => void) => Component,
        settings: { overlayOptions: object }) => new Promise<unknown>((resolve) => {
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
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      if (options.failSave) throw new Error("Storage unavailable");
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(content: unknown, sendOptions?: unknown) {
      if (options.failSend) throw new Error("Delivery unavailable");
      assert.equal(typeof content, "string");
      sent.push({ content: content as string, options: sendOptions });
    },
  };
  const controller = new SelectionComments(tui, ctx, pi, theme);
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
    tui, terminal, controller, ctx, pi, sent, notices, mainInput, entries, select, click, mouse,
    get dialog() { return dialog; },
    get draft() { return draft; },
    close() { controller.dispose(); tui.stop(); },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function saveNote(h: ReturnType<typeof harness>, comment: string, key = "\r") {
  const pending = h.controller.openComment();
  h.terminal.input(comment);
  h.terminal.input(key);
  await pending;
}

function clickText(h: ReturnType<typeof harness>, text: string) {
  h.tui.renderNow();
  const screen = h.tui.getScreenLines().map(stripTerminalSequences);
  const y = screen.findIndex((line) => line.includes(text));
  assert.notEqual(y, -1, `Expected visible control: ${text}`);
  h.click(visibleWidth(screen[y].slice(0, screen[y].indexOf(text))), y);
}

test("selecting shows a clickable Comment button without sending or taking keyboard focus", async () => {
  const h = harness();
  try {
    h.select();
    assert.equal(h.sent.length, 0);
    assert.ok(stripTerminalSequences(h.tui.getScreenLines()[0]).includes("+ Comment"));
    h.click(14, 0);
    assert.ok((h.dialog as Component | undefined) instanceof CommentDialog);
    h.terminal.input("Please explain this");
    h.terminal.input("\x1b[13;5u");
    await flush();
    assert.deepEqual(h.sent, [{
      content: commentsPrompt([{ quote: "alpha", comment: "Please explain this" }]),
      options: { deliverAs: "followUp", expandPromptTemplates: false },
    }]);
    assert.equal(h.draft, "Existing unsent prompt");
    assert.equal(h.tui.hasOverlay(), false);
  } finally { h.close(); }
});

test("Escape dismisses the Comment button without reaching the agent's interrupt key", () => {
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

test("global note shortcuts use F6/F7/F8 instead of Alt", () => {
  const shortcuts = new Map<string, { description?: string }>();
  selectionComments({
    on() {},
    registerCommand() {},
    registerShortcut(key: string, options: { description?: string }) { shortcuts.set(key, options); },
  } as unknown as ExtensionAPI);
  assert.deepEqual([...shortcuts.keys()], ["f6", "f7", "f8"]);
  assert.ok(shortcuts.get("f6")?.description?.includes("Add a note"));
  assert.ok(shortcuts.get("f7")?.description?.includes("Review"));
  assert.ok(shortcuts.get("f8")?.description?.includes("Send all"));
});

test("the Comment button uses readable text on a neutral background", () => {
  const h = harness();
  const tokens: string[] = [];
  const palette = {
    ...theme,
    fg: (color: string, text: string) => { tokens.push(`fg:${color}:${text}`); return text; },
    bg: (color: string, text: string) => { tokens.push(`bg:${color}`); return text; },
  } as unknown as Theme;
  const styled = new SelectionComments(h.tui, h.ctx, h.pi, palette);
  try {
    h.select();
    assert.ok(tokens.includes("fg:text:Comment"));
    assert.ok(tokens.includes("bg:toolPendingBg"));
    assert.ok(!tokens.includes("fg:accent:Comment"));
  } finally { styled.dispose(); h.close(); }
});

test("a new selection replaces the quote; multiline reverse selections stay intact", async () => {
  const h = harness();
  try {
    h.select();
    h.select(5, 1, 6, 0);
    assert.equal((h.tui as unknown as { getActiveSelectionText(): string }).getActiveSelectionText(), "beta\nsecond");
    const pending = h.controller.openComment();
    h.terminal.input("Change only this passage");
    h.terminal.input("\x1b[13;5u");
    await pending;
    assert.equal(h.sent[0].content, commentsPrompt([{ quote: "beta\nsecond", comment: "Change only this passage" }]));
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
      if (send) assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", expandPromptTemplates: false });
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

test("delivery failure keeps the notes queued and does not disturb the main-editor draft", async () => {
  const h = harness({ failSend: true });
  try {
    h.select();
    const pending = h.controller.openComment();
    h.terminal.input("A comment worth keeping");
    h.terminal.input("\x1b[13;5u");
    await pending;
    assert.equal(h.draft, "Existing unsent prompt");
    assert.ok(h.controller.render().join("").includes("1 saved note"));
    assert.ok(h.notices.some((notice) => notice.includes("Saved notes are kept")));
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
    assert.ok(card[5].includes("Cancel  Save   Send all ⌃↵"));
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
  const regular = new SelectionComments(new TuiMainScreen(new TestTerminal()), h.ctx, h.pi, theme);
  const unsupported = new Proxy(h.tui, {
    get: (target, property, receiver) => property === "getActiveSelectionText"
      ? undefined : Reflect.get(target, property, receiver),
  });
  const guarded = new SelectionComments(unsupported, h.ctx, h.pi, theme);
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
  const controller = new SelectionComments(proxy, h.ctx, h.pi, theme);
  try {
    h.select();
    controller.dispose();
    assert.equal((h.tui as unknown as { handleViewportInput: unknown }).handleViewportInput,
      Object.getPrototypeOf(h.tui).handleViewportInput);
  } finally { controller.dispose(); h.close(); }
  const regular = new TuiMainScreen(new TestTerminal());
  const swapped = new SelectionComments(proxy, h.ctx, h.pi, theme);
  try {
    renderer = regular;
    swapped.render();
    renderer = h.tui;
    swapped.render();
    assert.equal(typeof (h.tui as unknown as { handleViewportInput: unknown }).handleViewportInput, "function");
  } finally { swapped.dispose(); }
});

test("Enter and Ctrl+S save hidden notes; the next card lists them and Ctrl+Enter sends one batch", async () => {
  const h = harness({ busy: true });
  try {
    h.select();
    await saveNote(h, "First comment");
    assert.equal(h.sent.length, 0);
    assert.equal(h.tui.hasOverlay(), false);
    assert.ok(h.controller.render().join("").includes("1 saved note"));
    assert.ok(!h.tui.getScreenLines().join("").includes("First comment"));
    h.select(6, 0, 9, 0);
    const pending = h.controller.openComment();
    h.tui.renderNow();
    const card = (h.dialog as CommentDialog).render(52).map(stripTerminalSequences);
    assert.ok(card.some((line) => line.includes("Saved · 1")));
    assert.ok(card.some((line) => line.includes("First comment")));
    h.terminal.input("Second comment");
    h.terminal.input("\x13");
    await pending;
    assert.equal(h.sent.length, 0);
    assert.ok(h.controller.render().join("").includes("2 saved notes"));
    const review = h.controller.openComment(true);
    h.terminal.input("\x1b[13;5u");
    await review;
    assert.deepEqual(h.sent, [{
      content: commentsPrompt([
        { quote: "alpha", comment: "First comment" },
        { quote: "beta", comment: "Second comment" },
      ]),
      options: { deliverAs: "followUp", expandPromptTemplates: false },
    }]);
    assert.deepEqual(h.controller.render(), []);
    h.select();
    const next = h.controller.openComment();
    assert.ok(!(h.dialog as CommentDialog).render(52).join("").includes("Saved ·"));
    h.terminal.input("\x1b");
    await next;
    assert.equal(h.draft, "Existing unsent prompt");
  } finally { h.close(); }
});

test("right click opens a note for the exact current selection and never sends by itself", async () => {
  const h = harness();
  try {
    h.mouse(2, 0, 0);
    h.mouse(2, 0, 0, true);
    assert.equal(h.dialog, undefined);
    h.select();
    h.mouse(2, 2, 0);
    h.mouse(2, 2, 0, true);
    assert.ok((h.dialog as Component | undefined) instanceof CommentDialog);
    assert.equal(h.sent.length, 0);
    h.terminal.input("Right-clicked note");
    h.terminal.input("\x13");
    await flush();
    h.controller.sendAll();
    assert.equal(h.sent[0].content, commentsPrompt([{ quote: "alpha", comment: "Right-clicked note" }]));
  } finally { h.close(); }
});

test("a saved note can be removed by mouse while the new comment draft stays intact", async () => {
  const h = harness();
  try {
    h.select();
    await saveNote(h, "Remove this");
    h.select(6, 0, 9, 0);
    await saveNote(h, "Keep this");
    h.select();
    const pending = h.controller.openComment();
    h.terminal.input("An unfinished comment");
    clickText(h, "×");
    assert.equal((h.dialog as CommentDialog).editor.getExpandedText(), "An unfinished comment");
    assert.ok(!(h.dialog as CommentDialog).render(52).join("").includes("Remove this"));
    assert.ok((h.dialog as CommentDialog).render(52).join("").includes("Keep this"));
    h.terminal.input("\x1b");
    await pending;
    h.controller.sendAll();
    assert.equal(h.sent[0].content, commentsPrompt([{ quote: "beta", comment: "Keep this" }]));
  } finally { h.close(); }
});

test("the quiet queue hint supports mouse review and mouse sending without a selection", async () => {
  const h = harness();
  try {
    h.select();
    await saveNote(h, "A saved comment");
    clickText(h, "Review");
    assert.ok(h.dialog instanceof CommentDialog);
    assert.ok((h.dialog as CommentDialog).render(52).join("").includes("Saved notes"));
    h.terminal.input("\x1b");
    await flush();
    clickText(h, "Send all");
    assert.equal(h.sent.length, 1);
    h.controller.sendAll();
    assert.equal(h.sent.length, 1);
  } finally { h.close(); }
});

test("unsent notes survive reload; submitted batches can be recovered without losing newer notes", async () => {
  const first = harness();
  first.select();
  await saveNote(first, "Keep across reload");
  const firstSnapshot = JSON.stringify(first.entries[0]);
  first.close();
  const resumed = harness({ entries: first.entries });
  try {
    assert.ok(resumed.controller.render().join("").includes("1 saved note"));
    resumed.controller.sendAll();
    assert.equal(resumed.sent[0].content, commentsPrompt([{ quote: "alpha", comment: "Keep across reload" }]));
    assert.equal(JSON.stringify(first.entries[0]), firstSnapshot);
    assert.deepEqual(resumed.controller.render(), []);
    resumed.select(6, 0, 9, 0);
    await saveNote(resumed, "A newer note");
    resumed.controller.recoverNotes();
    resumed.controller.sendAll();
    assert.equal(resumed.sent[1].content, commentsPrompt([
      { quote: "alpha", comment: "Keep across reload" },
      { quote: "beta", comment: "A newer note" },
    ]));
  } finally { resumed.close(); }
});

test("restoring another branch cancels the old dialog and never carries its unsaved comment", async () => {
  const h = harness();
  try {
    h.select();
    const pending = h.controller.openComment();
    h.terminal.input("Old branch draft");
    h.entries.push({
      type: "custom", customType: "selection-comments-queue",
      data: { notes: [{ quote: "Other branch", comment: "Other note" }, null, { quote: 7, comment: "Invalid" }] },
    });
    h.controller.restore();
    await pending;
    h.controller.sendAll();
    assert.equal(h.sent[0].content, commentsPrompt([{ quote: "Other branch", comment: "Other note" }]));
    assert.equal(h.tui.hasOverlay(), false);
  } finally { h.close(); }
});

test("a storage failure preserves the new comment alongside the existing editor draft", async () => {
  const h = harness({ failSave: true });
  try {
    h.select();
    await saveNote(h, "Do not lose this comment", "\x13");
    assert.equal(h.sent.length, 0);
    assert.equal(h.draft, `Existing unsent prompt\n\n${commentPrompt("alpha", "Do not lose this comment")}`);
    assert.ok(h.notices.some((notice) => notice.includes("Comment kept in the main editor")));
  } finally { h.close(); }
});

test("long queues stay bounded, support keyboard deletion, and preserve multiline comments", () => {
  const h = harness();
  try {
    const notes = Array.from({ length: 25 }, (_, index) => ({
      quote: `Quote ${index + 1} 中文`, comment: `Saved comment ${index + 1}`,
    }));
    let result: unknown;
    const dialog = new CommentDialog(h.tui, theme, "Some selected text", (value) => { result = value; },
      notes, (index) => { notes.splice(index, 1); });
    dialog.focused = true;
    const comment = Array.from({ length: 14 }, (_, index) => `line ${index}`).join("\n");
    dialog.editor.setText(comment);
    for (const rows of [18, 24]) {
      h.terminal.rows = rows;
      for (const width of [18, 52]) {
        const card = dialog.render(width);
        assert.ok(card.length <= rows - 2);
        assert.ok(card.every((line) => visibleWidth(line) <= width));
        assert.ok(stripTerminalSequences(card.at(-2)!).includes("Send"));
      }
    }
    dialog.handleInput("\t");
    for (let i = 0; i < 4; i++) dialog.handleInput("\x1b[B");
    dialog.handleInput("\x1b[3~");
    assert.equal(notes.length, 24);
    assert.ok(!notes.some((note) => note.comment === "Saved comment 5"));
    assert.equal(dialog.editor.getExpandedText(), comment);
    dialog.handleInput("\t");
    dialog.handleInput("\x1b[13;5u");
    assert.deepEqual(result, { action: "send", comment });
  } finally { h.close(); }
});

test("mouse cursor placement accounts for the shortened multiline editor viewport", async () => {
  const h = harness();
  try {
    h.select();
    const pending = h.controller.openComment();
    const dialog = h.dialog as CommentDialog;
    dialog.editor.setText(Array.from({ length: 8 }, (_, index) => `line${index}`).join("\n"));
    h.tui.renderNow();
    const screen = h.tui.getScreenLines().map(stripTerminalSequences);
    const y = screen.findIndex((line) => line.includes("line7"));
    h.click(screen[y].indexOf("line7") + 4, y);
    h.terminal.input("X");
    assert.ok(dialog.editor.getExpandedText().endsWith("lineX7"));
    h.terminal.input("\x1b");
    await pending;
  } finally { h.close(); }
});

test("mouse Save queues a note; Send all includes the next unsaved draft exactly once", async () => {
  const h = harness();
  try {
    h.select();
    const first = h.controller.openComment();
    h.terminal.input("Mouse-saved note");
    clickText(h, "Save  ");
    await first;
    assert.equal(h.sent.length, 0);
    h.select(6, 0, 9, 0);
    const second = h.controller.openComment();
    h.terminal.input("A draft to include");
    clickText(h, "Send all");
    await second;
    assert.equal(h.sent[0].content, commentsPrompt([
      { quote: "alpha", comment: "Mouse-saved note" },
      { quote: "beta", comment: "A draft to include" },
    ]));
    assert.deepEqual(h.controller.render(), []);
    h.controller.sendAll();
    assert.equal(h.sent.length, 1);
  } finally { h.close(); }
});

test("wheel scrolling reveals the next saved note immediately without editing the draft", async () => {
  const h = harness({ entries: [{
    type: "custom", customType: "selection-comments-queue",
    data: { notes: Array.from({ length: 10 }, (_, i) => ({ quote: `Excerpt ${i + 1}`, comment: `Note ${i + 1}` })) },
  }] });
  try {
    h.select();
    const pending = h.controller.openComment();
    h.terminal.input("Keep typing here");
    h.tui.renderNow();
    const screen = h.tui.getScreenLines().map(stripTerminalSequences);
    const y = screen.findIndex((line) => line.includes("Excerpt 1"));
    h.mouse(65, screen[y].indexOf("Excerpt 1"), y);
    h.tui.renderNow();
    const card = (h.dialog as CommentDialog).render(52).map(stripTerminalSequences).join("\n");
    assert.ok(!card.includes("1  Excerpt 1 "));
    assert.ok(card.includes("2  Excerpt 2"));
    assert.equal((h.dialog as CommentDialog).editor.getExpandedText(), "Keep typing here");
    h.terminal.input("\x1b");
    await pending;
    assert.equal(h.sent.length, 0);
  } finally { h.close(); }
});

test("if recording submission fails, the batch stays queued and the user is warned before resending", async () => {
  const options = { failSave: false };
  const h = harness(options);
  try {
    h.select();
    await saveNote(h, "A durable saved note");
    options.failSave = true;
    h.controller.sendAll();
    assert.equal(h.sent.length, 1);
    assert.ok(h.controller.render().join("").includes("1 saved note"));
    assert.ok(h.notices.some((notice) => notice.includes("Check before resending")));
  } finally { h.close(); }
});

for (const [action, key] of [["save", "\r"], ["send", "\x1b[13;5u"]]) {
  test(`a resolved ${action} result cannot cross into a different branch`, async () => {
    const h = harness();
    try {
      h.select();
      const pending = h.controller.openComment();
      h.terminal.input("Old branch comment");
      h.terminal.input(key);
      h.entries.push({
        type: "custom", customType: "selection-comments-queue",
        data: { notes: [{ quote: "New branch", comment: "Keep this separate" }] },
      });
      h.controller.restore();
      await pending;
      assert.equal(h.sent.length, 0);
      h.controller.sendAll();
      assert.equal(h.sent[0].content, commentsPrompt([{ quote: "New branch", comment: "Keep this separate" }]));
    } finally { h.close(); }
  });
}

test("short terminals keep all actions onscreen by compacting quote and queue previews", () => {
  const h = harness();
  try {
    const notes = Array.from({ length: 8 }, (_, i) => ({ quote: `Saved quote ${i}`, comment: `Saved comment ${i}` }));
    for (const rows of [8, 10, 14]) {
      h.terminal.rows = rows;
      const dialog = new CommentDialog(h.tui, theme, "A long selected passage that wraps over two rows in this card.\nMore context",
        () => {}, notes);
      dialog.focused = true;
      dialog.editor.setText("Keep the comment intact");
      const card = dialog.render(52).map(stripTerminalSequences);
      assert.ok(card.length <= rows - 2, `${rows} rows: ${card.length}-row card`);
      assert.ok(card.at(-2)?.includes("Cancel  Save   Send all"));
      assert.equal(dialog.editor.getExpandedText(), "Keep the comment intact");
    }
  } finally { h.close(); }
});
