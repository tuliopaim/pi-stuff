import type { ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import type { SubagentManager } from "./manager.ts";
import type { SubagentSnapshot } from "./domain.ts";
import type { TranscriptEntry } from "../workflows/model.ts";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import { sanitizeTerminalText } from "./presentation.ts";
export { sanitizeTerminalText } from "./presentation.ts";

type Theme = ExtensionCommandContext["ui"]["theme"];

function elapsed(snapshot: SubagentSnapshot) {
  const seconds = Math.max(0, Math.round(((snapshot.settledAt ?? Date.now()) - snapshot.createdAt) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

function clock(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "--:--:--";
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function fullTimestamp(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "unknown";
  const date = new Date(timestamp);
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("-");
  return `${day} ${clock(timestamp)}`;
}

function padVisible(text: string, width: number) {
  const truncated = truncateToWidth(text, width, "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

interface TimelineWindow { start: number; end: number }

function timelineWindow(entries: readonly SubagentSnapshot[], now: number): TimelineWindow {
  const starts = entries.map((entry) => entry.createdAt).filter(Number.isFinite);
  const ends = entries.map((entry) => entry.settledAt ?? now).filter(Number.isFinite);
  const start = starts.length ? Math.min(...starts) : now;
  return { start, end: Math.max(start + 1, ...(ends.length ? ends : [now])) };
}

export function renderTimelineBar(snapshot: Pick<SubagentSnapshot, "createdAt" | "settledAt" | "status">, window: TimelineWindow, width: number) {
  const size = Math.max(3, width);
  const span = Math.max(1, window.end - window.start);
  const position = (timestamp: number) => Math.max(0, Math.min(size - 1, Math.round(((timestamp - window.start) / span) * (size - 1))));
  const start = position(snapshot.createdAt);
  const end = Math.max(start, position(snapshot.settledAt ?? window.end));
  const cells = Array.from({ length: size }, () => " ");
  if (start === end) cells[start] = snapshot.status === "running" ? "▶" : "◆";
  else {
    cells[start] = "├";
    for (let index = start + 1; index < end; index++) cells[index] = "━";
    cells[end] = snapshot.status === "running" ? "▶" : "┤";
  }
  return cells.join("");
}

function square(snapshot: SubagentSnapshot, theme: Theme) {
  return theme.fg(snapshot.status === "done" ? "success" : snapshot.status === "running" ? "warning" : "error", "■");
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
    if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "tui.editor.cursorLeft") || data === "h") return this.done(null);
    if (this.keys.matches(data, "tui.select.confirm") || this.keys.matches(data, "tui.editor.cursorRight") || data === "l") return this.done(entries[this.selection.index]?.id ?? null);
    if (this.keys.matches(data, "tui.select.up") || data === "k") this.selection.index = (this.selection.index - 1 + entries.length) % Math.max(1, entries.length);
    if (this.keys.matches(data, "tui.select.down") || data === "j") this.selection.index = (this.selection.index + 1) % Math.max(1, entries.length);
    if (data === "g") this.selection.index = 0;
    if (data === "G") this.selection.index = Math.max(0, entries.length - 1);
    if (data === "x") { const selected = entries[this.selection.index]; if (selected?.status === "running") void this.manager.cancel([selected.id]); }
    this.selection.id = entries[this.selection.index]?.id;
    this.tui.requestRender();
  }
  render(width: number) {
    const entries = this.manager.list();
    reconcileDashboardSelection(this.selection, entries);
    const height = Math.max(6, (this.tui.terminal.rows || 30) - 5);
    const now = Date.now();
    const window = timelineWindow(entries, now);
    const wide = width >= 96;
    const capacity = wide ? height : Math.max(3, Math.floor(height / 2));
    const start = Math.max(0, Math.min(this.selection.index - Math.floor(capacity / 2), entries.length - capacity));
    const timelineWidth = Math.max(18, Math.min(32, Math.floor(width * 0.24)));
    const titleWidth = Math.max(18, width - timelineWidth - 38);
    const timelineHeading = `${clock(window.start)}${" ".repeat(Math.max(1, timelineWidth - 16))}${clock(window.end)}`;
    const lines = [
      this.theme.bold(this.theme.fg("accent", `Subagents · ${entries.length}`)),
      wide
        ? this.theme.fg("dim", `${padVisible("  AGENT", titleWidth + 4)}START     END       DUR     ${padVisible(timelineHeading, timelineWidth)}`)
        : this.theme.fg("dim", "  AGENT · START → END · DURATION"),
      this.theme.fg("border", "─".repeat(width)),
    ];
    for (const [offset, entry] of entries.slice(start, start + capacity).entries()) {
      const marker = start + offset === this.selection.index ? this.theme.fg("accent", "❯") : " ";
      const context = formatContextUtilization({ tokens: entry.usage.contextTokens, contextWindow: entry.usage.contextWindow }) || `${entry.usage.contextTokens} tok`;
      const ended = entry.settledAt ? clock(entry.settledAt) : "running ";
      if (wide) {
        const identity = padVisible(`${marker} ${square(entry, this.theme)} ${sanitizeTerminalText(entry.title)}`, titleWidth + 4);
        const color = entry.status === "done" ? "success" : entry.status === "running" ? "warning" : "error";
        const bar = this.theme.fg(color, renderTimelineBar(entry, window, timelineWidth));
        lines.push(truncateToWidth(`${identity}${clock(entry.createdAt)}  ${ended}  ${padVisible(elapsed(entry), 7)} ${bar}`, width));
      } else {
        lines.push(truncateToWidth(`${marker} ${square(entry, this.theme)} ${sanitizeTerminalText(entry.title)} ${this.theme.fg("dim", `· ${elapsed(entry)}`)}`, width));
        lines.push(truncateToWidth(this.theme.fg("dim", `    ${clock(entry.createdAt)} → ${ended.trim()} · ${entry.id} · ${entry.model}:${entry.thinking} · ${context}`), width));
      }
    }
    while (lines.length < height + 3) lines.push("");
    lines.push(this.theme.fg("dim", "j/k select · g/G first/last · l/enter inspect · h/esc close · x abort"));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function toolSummary(entry: TranscriptEntry) {
  const name = sanitizeTerminalText(entry.name ?? "tool");
  try {
    const args = JSON.parse(entry.text) as Record<string, unknown>;
    const detail = ["path", "query", "command", "task", "url"]
      .map((key) => args[key])
      .find((value) => typeof value === "string");
    return detail ? `${name}  ${sanitizeTerminalText(String(detail)).replace(/\s+/g, " ")}` : name;
  } catch {
    return `${name}  ${sanitizeTerminalText(entry.text).replace(/\s+/g, " ")}`.trim();
  }
}

function previewLines(text: string, limit: number) {
  const all = sanitizeTerminalText(text).split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const shown = all.slice(0, limit);
  if (all.length > limit) shown.push(`… ${all.length - limit} more line${all.length - limit === 1 ? "" : "s"}`);
  return shown;
}

function transcriptMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
    highlightCode: (code) => code.split("\n").map((line) => theme.fg("mdCodeBlock", line)),
  };
}

function transcriptLines(snapshot: SubagentSnapshot, width: number, theme: Theme) {
  const lines: string[] = [];
  const markdownTheme = transcriptMarkdownTheme(theme);
  for (const entry of snapshot.transcript) {
    if (entry.role === "assistant") {
      lines.push(...new Markdown(sanitizeTerminalText(entry.text), 2, 0, markdownTheme).render(width));
      lines.push("");
    } else if (entry.role === "user") {
      lines.push(theme.fg("accent", theme.bold("Task")));
      lines.push(...wrapTextWithAnsi(theme.fg("text", sanitizeTerminalText(entry.text)), Math.max(10, width - 2)).map((line) => `  ${line}`));
      lines.push("");
    } else if (entry.role === "thinking") {
      const thought = previewLines(entry.text, 1)[0];
      if (thought) lines.push(truncateToWidth(theme.fg("dim", `  Thinking · ${thought}`), width));
    } else if (entry.role === "tool") {
      lines.push(truncateToWidth(`${theme.fg("warning", "›")} ${theme.fg("toolTitle", toolSummary(entry))}`, width));
    } else if (entry.isError) {
      for (const line of previewLines(entry.text, 4)) lines.push(truncateToWidth(theme.fg("error", `  │ ${line}`), width));
    } else {
      for (const line of previewLines(entry.text, 2)) lines.push(truncateToWidth(theme.fg("dim", `  │ ${line}`), width));
      lines.push("");
    }
  }
  if (snapshot.liveThinking) {
    const thought = previewLines(snapshot.liveThinking, 1).at(-1);
    lines.push(truncateToWidth(theme.fg("dim", `  Thinking…${thought ? ` ${thought}` : ""}`), width));
  }
  if (snapshot.liveText) lines.push(...new Markdown(sanitizeTerminalText(snapshot.liveText), 2, 0, markdownTheme).render(width));
  for (const queued of snapshot.queued) lines.push(theme.fg("warning", `  Guidance queued · ${sanitizeTerminalText(queued.text)}`));
  if (snapshot.error) lines.push(...wrapTextWithAnsi(theme.fg("error", `  ${sanitizeTerminalText(snapshot.error)}`), width));
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
  private inputMode = false;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && this.inputMode; }
  constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, manager: SubagentManager, id: string, done: () => void) {
    this.tui = tui; this.theme = theme; this.keys = keys; this.manager = manager; this.id = id; this.done = done;
    this.unsubscribe = manager.subscribeTo(id, () => {
      if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = undefined; tui.requestRender(); }, 50);
    });
    this.timer = setInterval(() => tui.requestRender(), 1000);
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue(""); this.inputMode = false; this.input.focused = false; this.offset = 0; this.sendError = undefined;
      void manager.send(id, text).catch((error) => { this.sendError = error instanceof Error ? error.message : String(error); this.tui.requestRender(); });
    };
  }
  dispose() { this.unsubscribe(); clearInterval(this.timer); if (this.renderTimer) clearTimeout(this.renderTimer); }
  invalidate() { this.input.invalidate(); }
  handleInput(data: string) {
    if (this.keys.matches(data, "app.clear") || data === "x") { const snapshot = this.manager.get(this.id); if (snapshot?.status === "running") void this.manager.cancel([this.id]); return; }
    if (this.inputMode) {
      if (this.keys.matches(data, "tui.select.cancel")) { this.inputMode = false; this.input.focused = false; this.tui.requestRender(); return; }
      this.input.handleInput(data); this.tui.requestRender(); return;
    }
    if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "app.interrupt") || this.keys.matches(data, "tui.editor.cursorLeft") || data === "h") return this.done();
    if (this.keys.matches(data, "tui.select.confirm") || data === "i") {
      this.inputMode = true; this.input.focused = this._focused; this.tui.requestRender(); return;
    }
    if (this.keys.matches(data, "tui.editor.cursorUp") || data === "k") { this.offset += 6; this.tui.requestRender(); return; }
    if (this.keys.matches(data, "tui.editor.cursorDown") || data === "j") { this.offset = Math.max(0, this.offset - 6); this.tui.requestRender(); return; }
    if (this.keys.matches(data, "tui.editor.pageUp")) { this.offset += this.viewportHeight(); this.tui.requestRender(); return; }
    if (this.keys.matches(data, "tui.editor.pageDown")) { this.offset = Math.max(0, this.offset - this.viewportHeight()); this.tui.requestRender(); return; }
    if (data === "g") { this.offset = Number.MAX_SAFE_INTEGER; this.tui.requestRender(); return; }
    if (data === "G") { this.offset = 0; this.tui.requestRender(); return; }
    if (data.length === 1 && data >= " ") { this.inputMode = true; this.input.focused = this._focused; this.input.handleInput(data); this.tui.requestRender(); }
  }
  private viewportHeight() { return Math.max(6, (this.tui.terminal.rows || 30) - (this.inputMode ? 9 : 7) - (this.sendError ? 1 : 0)); }
  render(width: number) {
    const snapshot = this.manager.get(this.id);
    if (!snapshot) return ["Subagent no longer tracked"];
    const viewport = this.viewportHeight();
    const transcript = transcriptLines(snapshot, width, this.theme);
    const context = formatContextUtilization({ tokens: snapshot.usage.contextTokens, contextWindow: snapshot.usage.contextWindow });
    this.offset = Math.min(this.offset, Math.max(0, transcript.length - viewport));
    const end = transcript.length - this.offset;
    const body = transcript.slice(Math.max(0, end - viewport), end);
    while (body.length < viewport) body.push("");
    const color = snapshot.status === "done" ? "success" : snapshot.status === "running" ? "warning" : "error";
    const position = this.offset > 0 ? this.theme.fg("warning", ` · ${this.offset} line${this.offset === 1 ? "" : "s"} below`) : "";
    return [
      truncateToWidth(`${this.theme.fg("accent", "‹ Subagents /")} ${this.theme.bold(sanitizeTerminalText(snapshot.title))}`, width),
      truncateToWidth(`${square(snapshot, this.theme)} ${this.theme.fg(color, snapshot.status)} · ${snapshot.origin} · ${snapshot.model}:${snapshot.thinking} · ${elapsed(snapshot)}${context ? ` · ${context}` : ""}${position}`, width),
      truncateToWidth(this.theme.fg("dim", `Started ${fullTimestamp(snapshot.createdAt)} · Ended ${snapshot.settledAt ? fullTimestamp(snapshot.settledAt) : "running"} · ${snapshot.id}`), width),
      this.theme.fg("border", "─".repeat(width)),
      ...body.map((line) => truncateToWidth(line, width)),
      this.theme.fg("border", "─".repeat(width)),
      ...(this.inputMode ? [this.theme.fg("accent", "Send guidance"), ...this.input.render(width)] : []),
      ...(this.sendError ? [truncateToWidth(this.theme.fg("error", sanitizeTerminalText(this.sendError)), width)] : []),
      this.theme.fg("dim", this.inputMode
        ? "enter send · esc cancel"
        : `j/k scroll · g/G top/bottom · pgup/pgdn page · i send guidance · h/esc back${snapshot.status === "running" ? " · x abort" : ""}`),
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
