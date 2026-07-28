import type { ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { SubagentManager } from "./manager.ts";
import type { SubagentSnapshot } from "./domain.ts";

type Theme = ExtensionCommandContext["ui"]["theme"];

function elapsed(snapshot: SubagentSnapshot) {
  const seconds = Math.max(0, Math.round(((snapshot.settledAt ?? Date.now()) - snapshot.createdAt) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

function square(snapshot: SubagentSnapshot, theme: Theme) {
  return theme.fg(snapshot.status === "done" ? "success" : snapshot.status === "running" ? "warning" : "error", "■");
}

export function sanitizeTerminalText(text: string) {
  return text
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

export interface DashboardSelection { id?: string; index: number }
export function reconcileDashboardSelection(selection: DashboardSelection, entries: ReadonlyArray<Pick<SubagentSnapshot, "id">>) {
  const stable = selection.id ? entries.findIndex((entry) => entry.id === selection.id) : -1;
  selection.index = stable >= 0 ? stable : Math.min(Math.max(0, selection.index), Math.max(0, entries.length - 1));
  selection.id = entries[selection.index]?.id;
}

class Dashboard implements Component {
  private selection: DashboardSelection = { index: 0 };
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private tui: TUI;
  private theme: Theme;
  private keys: KeybindingsManager;
  private manager: SubagentManager;
  private done: (id: string | null) => void;
  constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, manager: SubagentManager, done: (id: string | null) => void) {
    this.tui = tui; this.theme = theme; this.keys = keys; this.manager = manager; this.done = done;
    this.unsubscribe = manager.subscribe(() => tui.requestRender());
    this.timer = setInterval(() => tui.requestRender(), 1000);
  }
  dispose() { this.unsubscribe(); clearInterval(this.timer); }
  invalidate() {}
  handleInput(data: string) {
    const entries = this.manager.list();
    reconcileDashboardSelection(this.selection, entries);
    if (this.keys.matches(data, "tui.select.cancel")) return this.done(null);
    if (this.keys.matches(data, "tui.select.confirm")) return this.done(entries[this.selection.index]?.id ?? null);
    if (this.keys.matches(data, "tui.select.up") || data === "k") this.selection.index = (this.selection.index - 1 + entries.length) % Math.max(1, entries.length);
    if (this.keys.matches(data, "tui.select.down") || data === "j") this.selection.index = (this.selection.index + 1) % Math.max(1, entries.length);
    if (data === "x") { const selected = entries[this.selection.index]; if (selected?.status === "running") void this.manager.cancel([selected.id]); }
    this.selection.id = entries[this.selection.index]?.id;
    this.tui.requestRender();
  }
  render(width: number) {
    const entries = this.manager.list();
    reconcileDashboardSelection(this.selection, entries);
    const height = Math.max(6, (this.tui.terminal.rows || 30) - 5);
    const start = Math.max(0, Math.min(this.selection.index - Math.floor(height / 2), entries.length - height));
    const lines = [this.theme.bold(this.theme.fg("accent", `Subagents · ${entries.length}`)), this.theme.fg("border", "─".repeat(width))];
    for (const [offset, entry] of entries.slice(start, start + height).entries()) {
      const marker = start + offset === this.selection.index ? this.theme.fg("accent", "❯") : " ";
      const context = entry.usage.contextWindow ? `${Math.round(entry.usage.contextTokens / entry.usage.contextWindow * 100)}%` : `${entry.usage.contextTokens} tok`;
      lines.push(truncateToWidth(`${marker} ${square(entry, this.theme)} ${sanitizeTerminalText(entry.title)} ${this.theme.fg("dim", sanitizeTerminalText(`${entry.id} · ${entry.origin} · ${entry.model}:${entry.thinking} · ${context} · ${elapsed(entry)} · ${entry.cwd}${entry.restored ? " · restored" : ""}`))}`, width));
    }
    while (lines.length < height + 2) lines.push("");
    lines.push(this.theme.fg("dim", "j/k select · enter inspect · x abort · esc close"));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function transcriptLines(snapshot: SubagentSnapshot, width: number, theme: Theme) {
  const lines: string[] = [];
  for (const entry of snapshot.transcript) {
    const label = sanitizeTerminalText(entry.role === "toolResult" ? `${entry.isError ? "error" : "result"} ${entry.name ?? ""}` : entry.role);
    lines.push(theme.fg(entry.isError ? "error" : entry.role === "assistant" ? "success" : entry.role === "thinking" ? "dim" : "accent", label.toUpperCase()));
    lines.push(...wrapTextWithAnsi(theme.fg(entry.role === "thinking" ? "dim" : "text", sanitizeTerminalText(entry.text)), Math.max(10, width)));
    lines.push("");
  }
  if (snapshot.liveThinking) lines.push(...wrapTextWithAnsi(theme.fg("dim", sanitizeTerminalText(snapshot.liveThinking)), width));
  if (snapshot.liveText) lines.push(...wrapTextWithAnsi(sanitizeTerminalText(snapshot.liveText), width));
  for (const queued of snapshot.queued) lines.push(theme.fg("warning", `[queued ${queued.kind}] ${sanitizeTerminalText(queued.text)}`));
  return lines;
}

export class Takeover implements Component, Focusable {
  private input = new Input();
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private offset = 0;
  private _focused = false;
  private tui: TUI;
  private theme: Theme;
  private keys: KeybindingsManager;
  private manager: SubagentManager;
  private id: string;
  private done: () => void;
  private sendError?: string;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }
  constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, manager: SubagentManager, id: string, done: () => void) {
    this.tui = tui; this.theme = theme; this.keys = keys; this.manager = manager; this.id = id; this.done = done;
    this.unsubscribe = manager.subscribeTo(id, () => {
      if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = undefined; tui.requestRender(); }, 50);
    });
    this.timer = setInterval(() => tui.requestRender(), 1000);
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue(""); this.offset = 0; this.sendError = undefined;
      void manager.send(id, text).catch((error) => { this.sendError = error instanceof Error ? error.message : String(error); this.tui.requestRender(); });
    };
  }
  dispose() { this.unsubscribe(); clearInterval(this.timer); if (this.renderTimer) clearTimeout(this.renderTimer); }
  invalidate() { this.input.invalidate(); }
  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "app.interrupt")) return this.done();
    if (this.keys.matches(data, "app.clear")) { const snapshot = this.manager.get(this.id); if (snapshot?.status === "running") void this.manager.cancel([this.id]); return; }
    if (this.keys.matches(data, "tui.editor.cursorUp")) { this.offset += 6; this.tui.requestRender(); return; }
    if (this.keys.matches(data, "tui.editor.cursorDown")) { this.offset = Math.max(0, this.offset - 6); this.tui.requestRender(); return; }
    this.input.handleInput(data); this.tui.requestRender();
  }
  render(width: number) {
    const snapshot = this.manager.get(this.id);
    if (!snapshot) return ["Subagent no longer tracked"];
    const viewport = Math.max(6, (this.tui.terminal.rows || 30) - 8);
    const transcript = transcriptLines(snapshot, width, this.theme);
    this.offset = Math.min(this.offset, Math.max(0, transcript.length - viewport));
    const end = transcript.length - this.offset;
    const body = transcript.slice(Math.max(0, end - viewport), end);
    while (body.length < viewport) body.unshift("");
    return [
      this.theme.fg("borderAccent", "─".repeat(width)),
      truncateToWidth(`${square(snapshot, this.theme)} ${this.theme.bold(sanitizeTerminalText(snapshot.title))} · ${sanitizeTerminalText(`${snapshot.id} · ${snapshot.status} · ${elapsed(snapshot)} · ${snapshot.model}:${snapshot.thinking}`)}`, width),
      this.theme.fg("borderAccent", "─".repeat(width)),
      ...body.map((line) => truncateToWidth(line, width)),
      this.theme.fg("borderAccent", "─".repeat(width)),
      ...this.input.render(width),
      ...(this.sendError ? [truncateToWidth(this.theme.fg("error", sanitizeTerminalText(this.sendError)), width)] : []),
      this.theme.fg("dim", "enter send/continue · esc back · ctrl+l abort · up/down scroll"),
    ];
  }
}

export async function showTakeover(ctx: ExtensionCommandContext, manager: SubagentManager, id: string) {
  await ctx.ui.custom<void>((tui, theme, keys, done) => new Takeover(tui, theme, keys, manager, id, done), {
    overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
  });
}

export async function showSubagents(ctx: ExtensionCommandContext, manager: SubagentManager, initialId?: string) {
  if (initialId && manager.get(initialId)) return showTakeover(ctx, manager, initialId);
  while (true) {
    const id = await ctx.ui.custom<string | null>((tui, theme, keys, done) => new Dashboard(tui, theme, keys, manager, done), {
      overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    });
    if (!id) return;
    await showTakeover(ctx, manager, id);
  }
}
