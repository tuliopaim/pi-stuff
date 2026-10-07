import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, getMarkdownTheme, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { AgentJobs, Job, JobMetadata } from "./durable.ts";
import { getActiveSubagentPresetName, getAgents } from "./config.ts";
import { activeJob, elapsed, jobActivity, jobColor as color, jobSummary, jobTitle, pendingJob, terminalText } from "./presentation.ts";

type Theme = ExtensionContext["ui"]["theme"];
type Action = "configure" | "preset" | undefined;
const pad = (text: string, width: number) => {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};
const clock = (time?: number) => time === undefined ? "--:--:--" : new Date(time).toLocaleTimeString("en-GB", { hour12: false });
const toolDefinitions = {
  bash: createBashToolDefinition, read: createReadToolDefinition, edit: createEditToolDefinition,
  write: createWriteToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition,
};

export function timelineBar(job: Job, start: number, end: number, width: number) {
  const cells = Array<string>(Math.max(3, width)).fill(" ");
  const position = (time: number) => Math.max(0, Math.min(cells.length - 1, Math.round((time - start) / Math.max(1, end - start) * (cells.length - 1))));
  const first = position(job.startedAt), last = Math.max(first, position(job.finishedAt ?? end));
  cells[first] = first === last ? "◆" : "├";
  for (let i = first + 1; i < last; i++) cells[i] = "━";
  cells[last] = pendingJob(job) ? "▶" : first === last ? "◆" : "┤";
  return cells.join("");
}

export class Dashboard implements Component, Focusable {
  private entries: Job[] = [];
  private selectedId?: string;
  private index = 0;
  private detailId?: string;
  private messages: Message[] = [];
  private transcript: Component[] = [];
  private metadata?: JobMetadata;
  private metadataId?: string;
  private historyLimit = 100;
  private offset = 0;
  private toolsExpanded = false;
  private hideThinking = true;
  private input = new Input();
  private inputMode = false;
  private _focused = false;
  private error?: string;
  private closed = false;
  private refreshing = false;
  private refreshAgain = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private timer: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private tui: TUI;
  private theme: Theme;
  private keys: KeybindingsManager;
  private jobs?: AgentJobs;
  private done: (action: Action) => void;

  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && this.inputMode; }

  constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, jobs: AgentJobs | undefined, done: (action: Action) => void, initialId?: string) {
    this.tui = tui; this.theme = theme; this.keys = keys; this.jobs = jobs; this.done = done;
    this.detailId = initialId;
    this.unsubscribe = jobs?.subscribe(() => this.scheduleRefresh());
    this.timer = setInterval(() => { this.scheduleRefresh(); tui.requestRender(); }, 1000);
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text || !this.detailId || !jobs) return;
      this.input.setValue(""); this.inputMode = false; this.input.focused = false; this.offset = 0;
      this.perform(() => jobs.message(this.detailId!, text));
    };
    void this.refresh();
  }

  dispose() { this.closed = true; this.unsubscribe?.(); clearInterval(this.timer); if (this.refreshTimer) clearTimeout(this.refreshTimer); }
  invalidate() { this.input.invalidate(); for (const component of this.transcript) component.invalidate(); }
  private scheduleRefresh() {
    if (this.closed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, 100);
  }
  private async refresh() {
    if (this.closed) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    try {
      const entries = [...(await this.jobs?.list() ?? [])].sort((a, b) => (b.createdAt ?? b.startedAt) - (a.createdAt ?? a.startedAt));
      if (this.closed) return;
      this.entries = entries;
      const stable = entries.findIndex((job) => job.id === this.selectedId);
      this.index = stable >= 0 ? stable : Math.min(this.index, Math.max(0, entries.length - 1));
      this.selectedId = entries[this.index]?.id;
      const detail = this.detailId;
      const id = detail ?? this.selectedId;
      if (id && this.jobs) {
        const resolved = entries.find((entry) => entry.id === id || entry.name === id);
        const canonical = resolved?.id ?? id;
        const [messages, metadata] = await Promise.all([detail ? this.jobs.transcript(canonical, this.historyLimit) : undefined, this.jobs.metadata?.(canonical)]);
        if (!this.closed && (this.detailId ?? this.selectedId) === id) {
          if (detail) {
            this.detailId = canonical; this.messages = messages ?? [];
            this.buildTranscript(resolved?.cwd ?? "");
          }
          this.metadata = metadata; this.metadataId = canonical;
        }
      }
    } catch (error) { this.error = String(error); }
    finally {
      this.refreshing = false;
      if (!this.closed) this.tui.requestRender();
      if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); }
    }
  }
  private perform(operation: () => Promise<unknown>) {
    this.error = undefined;
    void operation().catch((error) => { this.error = String(error); }).finally(() => this.scheduleRefresh());
    this.tui.requestRender();
  }

  private buildTranscript(cwd: string) {
    const components: Component[] = [];
    const tools = new Map<string, ToolExecutionComponent>();
    const cleanContent = (content: Message["content"]) => typeof content === "string" ? terminalText(content) :
      content.map((part) => part.type === "text" ? { ...part, text: terminalText(part.text) } :
        part.type === "thinking" ? { ...part, thinking: terminalText(part.thinking) } : part);
    for (const message of this.messages) {
      if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content :
          message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        components.push(new UserMessageComponent(terminalText(text), getMarkdownTheme()));
      } else if (message.role === "assistant") {
        components.push(new AssistantMessageComponent({ ...message, content: cleanContent(message.content) as typeof message.content }, this.hideThinking));
        for (const part of message.content) if (part.type === "toolCall") {
          const args = Object.fromEntries(Object.entries(part.arguments).map(([key, value]) => [key, typeof value === "string" ? terminalText(value) : value]));
          const factory = toolDefinitions[part.name as keyof typeof toolDefinitions];
          const tool = new ToolExecutionComponent(part.name, part.id, args, { showImages: false }, factory?.(cwd), this.tui, cwd);
          // This is a replay, not an execution. Do not mark args complete:
          // edit's live preview would otherwise read the current working tree.
          tool.setExpanded(this.toolsExpanded);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            tool.updateResult({ content: [{ type: "text", text: terminalText(message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error")) }], isError: true });
          }
          tools.set(part.id, tool);
          components.push(tool);
        }
      } else if (message.role === "toolResult") {
        let tool = tools.get(message.toolCallId);
        if (!tool) {
          // Older-history windows can start with the result of a call outside the window.
          tool = new ToolExecutionComponent(message.toolName, message.toolCallId, {}, { showImages: false }, undefined, this.tui, cwd);
          tool.setExpanded(this.toolsExpanded);
          components.push(tool);
        }
        tool.updateResult({ ...message, content: cleanContent(message.content) as typeof message.content, isError: message.isError ?? false });
      }
    }
    this.transcript = components;
  }

  handleInput(data: string) {
    const matches = (key: Parameters<KeybindingsManager["matches"]>[1]) => this.keys.matches(data, key);
    if (this.inputMode) {
      if (matches("tui.select.cancel")) { this.inputMode = false; this.input.focused = false; }
      else this.input.handleInput(data);
      this.tui.requestRender(); return;
    }
    if (matches("tui.select.cancel") || matches("tui.editor.cursorLeft") || data === "h") {
      if (!this.detailId) return this.done(undefined);
      this.detailId = undefined; this.messages = []; this.transcript = []; this.metadata = undefined; this.historyLimit = 100; this.error = undefined;
    } else if (!this.detailId && (data === "c" || data === "p")) return this.done(data === "c" ? "configure" : "preset");
    else if (data === "x") {
      const job = this.entries.find((job) => job.id === (this.detailId ?? this.selectedId));
      if (job && pendingJob(job) && this.jobs) this.perform(() => this.jobs!.cancel(job.id));
    } else if (this.detailId) {
      if (data === "i" || matches("tui.select.confirm")) { this.inputMode = true; this.input.focused = this.focused; }
      else if (data === "k" || matches("tui.select.up")) this.offset += 6;
      else if (data === "j" || matches("tui.select.down")) this.offset = Math.max(0, this.offset - 6);
      else if (matches("tui.editor.pageUp")) this.offset += this.height();
      else if (matches("tui.editor.pageDown")) this.offset = Math.max(0, this.offset - this.height());
      else if (data === "g") this.offset = Number.MAX_SAFE_INTEGER;
      else if (data === "G") this.offset = 0;
      else if (data === "o") { this.historyLimit += 100; this.scheduleRefresh(); }
      else if (matches("app.tools.expand")) {
        this.toolsExpanded = !this.toolsExpanded;
        for (const component of this.transcript) if (component instanceof ToolExecutionComponent) component.setExpanded(this.toolsExpanded);
        this.offset = 0;
      } else if (matches("app.thinking.toggle")) {
        this.hideThinking = !this.hideThinking;
        for (const component of this.transcript) if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(this.hideThinking);
        this.offset = 0;
      }
    } else {
      if (matches("tui.select.confirm") || matches("tui.editor.cursorRight") || data === "l") {
        this.detailId = this.selectedId; this.offset = 0; this.messages = []; this.transcript = []; this.scheduleRefresh();
      } else if (matches("tui.select.up") || data === "k") this.index = (this.index - 1 + this.entries.length) % Math.max(1, this.entries.length);
      else if (matches("tui.select.down") || data === "j") this.index = (this.index + 1) % Math.max(1, this.entries.length);
      else if (data === "g") this.index = 0;
      else if (data === "G") this.index = Math.max(0, this.entries.length - 1);
      this.selectedId = this.entries[this.index]?.id;
    }
    if (!this.detailId) this.scheduleRefresh();
    this.tui.requestRender();
  }
  private height() { return Math.max(3, (this.tui.terminal.rows || 30) - (this.inputMode ? 11 : 9)); }

  render(width: number) {
    const theme = this.theme;
    const job = this.entries.find((job) => job.id === this.detailId);
    const lines = job ? this.renderDetail(job, width) : this.renderList(width);
    if (this.error) lines.push(theme.fg("error", terminalText(this.error)));
    return lines.map((line) => truncateToWidth(line, width));
  }
  private renderList(width: number) {
    const theme = this.theme, now = Date.now(), capacity = this.height();
    const start = Math.max(0, Math.min(this.index - Math.floor(capacity / 2), this.entries.length - capacity));
    const beginning = Math.min(now, ...this.entries.map((job) => job.startedAt));
    const end = Math.max(beginning + 1, ...this.entries.map((job) => job.finishedAt ?? now));
    const wide = width >= 96;
    const timelineWidth = Math.max(12, Math.min(24, Math.floor(width * 0.18)));
    const titleWidth = Math.max(12, width - timelineWidth - 47);
    const lines = [theme.bold(theme.fg("accent", `Subagents · ${this.entries.length} jobs · preset ${getActiveSubagentPresetName()}`)),
      theme.fg("dim", wide ? `${pad("  AGENT / TASK", titleWidth)} ${pad("STATUS", 10)}START     END       DUR    TIMELINE` : "  AGENT / TASK · STATUS · START → END · DURATION"), theme.fg("border", "─".repeat(width))];
    for (const [offset, job] of this.entries.slice(start, start + capacity).entries()) {
      const identity = `${start + offset === this.index ? "❯" : " "} ${theme.fg(color(job), "■")} ${jobTitle(job)}`;
      const duration = elapsed(job.startedAt, job.finishedAt ?? now);
      lines.push(wide
        ? `${pad(identity, titleWidth)} ${pad(theme.fg(color(job), job.status), 10)}${clock(job.startedAt)}  ${clock(job.finishedAt)}  ${pad(duration, 6)} ${theme.fg(color(job), timelineBar(job, beginning, end, timelineWidth))}`
        : `${start + offset === this.index ? "❯" : " "} ${theme.fg(color(job), job.status)} · ${clock(job.startedAt)} → ${clock(job.finishedAt)} · ${duration} · ${jobTitle(job)}`);
    }
    if (!this.entries.length) {
      lines.push("No jobs yet. Agents appear here when you delegate work.", "");
      for (const [name, agent] of Object.entries(getAgents()).slice(0, Math.max(0, capacity - 2))) lines.push(`${name} · ${agent.model}:${agent.thinking}`);
    }
    const selected = this.entries[this.index];
    while (lines.length < capacity + 3) lines.push("");
    if (selected) lines.push(theme.fg("dim", `${jobSummary(selected, this.metadataId === selected.id ? this.metadata : undefined)} · ${selected.name ?? selected.id}`), theme.fg("muted", jobActivity(selected, this.jobs?.preview(selected.id))));
    lines.push(theme.fg("dim", "j/k select · enter/l inspect · x abort · c configure · p preset · esc close"));
    return lines;
  }
  private renderDetail(job: Job, width: number) {
    const theme = this.theme, body = this.transcript.flatMap((component) => component.render(width));
    const wrap = (text: string, color: Parameters<Theme["fg"]>[0]) =>
      wrapTextWithAnsi(text, Math.max(1, width)).map((line) => theme.fg(color, line));
    // The transcript already contains partial assistant text. Show only the
    // current tool/retry state here, not a second copy of the streamed answer.
    const activity = jobActivity(job, this.jobs?.preview(job.id));
    if (activeJob(job) && (!this.messages.length || /^(Running |Retrying:|Compacting context|Waiting for model|Stalled)/.test(activity))) body.push(...wrap(activity, "muted"));
    for (const item of this.metadata?.queued ?? []) if (item.mode !== "write") {
      const content = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
      body.push(...wrap(`Guidance queued · ${terminalText(content)}`, "warning"));
    }
    if (job.question) body.push(...wrapTextWithAnsi(theme.fg("warning", `Question for parent · ${terminalText(job.question.text)}`), Math.max(1, width)));
    if (job.error) body.push(...wrap(terminalText(job.error), "error"));
    const height = this.height();
    this.offset = Math.min(this.offset, Math.max(0, body.length - height));
    const end = body.length - this.offset;
    const shown = body.slice(Math.max(0, end - height), end);
    while (shown.length < height) shown.push("");
    return [theme.bold(theme.fg("accent", `‹ Subagents / ${jobTitle(job)}`)),
      `${theme.fg(color(job), job.status)} · ${jobSummary(job, this.metadata)}`,
      theme.fg("dim", `${job.name ?? job.id} · started ${clock(job.startedAt)} · ended ${clock(job.finishedAt)} · ${job.cwd}`),
      theme.fg("dim", `Conversation ${job.conversationId} · latest ${this.historyLimit} entries${this.offset ? ` · ${this.offset} lines below` : ""}`),
      theme.fg("border", "─".repeat(width)), ...shown,
      ...(this.inputMode ? [theme.fg("accent", job.status === "waiting" ? "Answer the child's question" : "Send guidance or follow-up"), ...this.input.render(width)] : []),
      theme.fg("dim", this.inputMode ? "enter send · esc cancel" : `ctrl+o expand · ctrl+t thinking · i ${job.status === "waiting" ? "answer" : "message"} · esc back · j/k scroll · g/G top/bottom · o older${pendingJob(job) ? " · x abort" : ""}`)];
  }
}

export function showAgents(ctx: ExtensionContext, jobs?: AgentJobs, initialId?: string) {
  return ctx.ui.custom<Action>((tui, theme, keys, done) => new Dashboard(tui, theme, keys, jobs, done, initialId), {
    overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
  });
}
