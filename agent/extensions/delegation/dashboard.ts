import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, getMarkdownTheme, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { AgentJobs, Job, JobMetadata } from "./durable.ts";
import { getActiveSubagentPresetName, getAgents } from "./config.ts";
import { activeJob, elapsed, framed, jobActivity, jobColor as color, pendingJob, shortPaths, spread, STATUS_ICONS, statusLabel, terminalText, toolSummary, usageText } from "./presentation.ts";

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

const oneLine = (text: string) => shortPaths(terminalText(text).replace(/\s+/g, " ").trim());
// Jobs that need the user come first, then live work, then history.
const rank = (job: Job) => job.status === "waiting" ? 0 : activeJob(job) ? 1 : 2;

type Expandable = Component & { expanded: boolean };

// One dim line per tool call; ctrl+o swaps in Pi's native tool card.
class ToolLine implements Expandable {
  expanded = false;
  private done = false;
  private error?: string;
  readonly tool: ToolExecutionComponent;
  private summary: string;
  private theme: Theme;
  constructor(tool: ToolExecutionComponent, summary: string, theme: Theme) { this.tool = tool; this.summary = summary; this.theme = theme; }
  update(result: Parameters<ToolExecutionComponent["updateResult"]>[0]) {
    this.done = true;
    this.error = result.isError ? result.content.flatMap((part) => part.type === "text" ? (part.text ?? "").split("\n") : []).find((line) => line.trim()) ?? "Error" : undefined;
    this.tool.updateResult(result);
  }
  invalidate() { this.tool.invalidate(); }
  render(width: number) {
    if (this.expanded) return this.tool.render(width);
    const theme = this.theme;
    const icon = this.error !== undefined ? theme.fg("error", "✗") : this.done ? theme.fg("success", "✓") : theme.fg("warning", "…");
    return [truncateToWidth(`  ${icon} ${theme.fg("dim", this.summary)}`, width),
      ...(this.error !== undefined ? [truncateToWidth(`    ${theme.fg("error", oneLine(this.error))}`, width)] : [])];
  }
}

// Task prompts can be pages long; show their opening until expanded.
class Clamp implements Expandable {
  expanded = false;
  private child: Component;
  private theme: Theme;
  private max: number;
  constructor(child: Component, theme: Theme, max = 4) { this.child = child; this.theme = theme; this.max = max; }
  invalidate() { this.child.invalidate(); }
  render(width: number) {
    const lines = this.child.render(width);
    return this.expanded || lines.length <= this.max + 1 ? lines : [...lines.slice(0, this.max), this.theme.fg("dim", truncateToWidth(`  … ${lines.length - this.max} more lines · ctrl+o`, width))];
  }
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
  private showInfo = false;
  private confirmCancel?: string;
  private autoAnswered?: string;
  private bodyHeight = 10;
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
      const entries = [...(await this.jobs?.list() ?? [])].sort((a, b) => rank(a) - rank(b) || (b.createdAt ?? b.startedAt) - (a.createdAt ?? a.startedAt));
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
            if (resolved?.status === "waiting" && this.autoAnswered !== canonical) {
              this.autoAnswered = canonical; this.inputMode = true; this.input.focused = this.focused;
            }
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
    const tools = new Map<string, ToolLine>();
    const theme = this.theme;
    const cleanContent = (content: Message["content"]) => typeof content === "string" ? terminalText(content) :
      content.map((part) => part.type === "text" ? { ...part, text: terminalText(part.text) } :
        part.type === "thinking" ? { ...part, thinking: terminalText(part.thinking) } : part);
    const line = (tool: ToolExecutionComponent, name: string, args: Record<string, unknown>) => {
      const component = new ToolLine(tool, oneLine(toolSummary(name, args)), theme);
      component.expanded = this.toolsExpanded;
      tool.setExpanded(true);
      return component;
    };
    for (const message of this.messages) {
      if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content :
          message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        const clamp = new Clamp(new UserMessageComponent(terminalText(text), getMarkdownTheme()), theme);
        clamp.expanded = this.toolsExpanded;
        components.push(clamp);
      } else if (message.role === "assistant") {
        components.push(new AssistantMessageComponent({ ...message, content: cleanContent(message.content) as typeof message.content }, this.hideThinking));
        for (const part of message.content) if (part.type === "toolCall") {
          const args = Object.fromEntries(Object.entries(part.arguments).map(([key, value]) => [key, typeof value === "string" ? terminalText(value) : value]));
          const factory = toolDefinitions[part.name as keyof typeof toolDefinitions];
          // This is a replay, not an execution. Do not mark args complete:
          // edit's live preview would otherwise read the current working tree.
          const tool = line(new ToolExecutionComponent(part.name, part.id, args, { showImages: false }, factory?.(cwd), this.tui, cwd), part.name, args);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            tool.update({ content: [{ type: "text", text: terminalText(message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error")) }], isError: true });
          }
          tools.set(part.id, tool);
          components.push(tool);
        }
      } else if (message.role === "toolResult") {
        let tool = tools.get(message.toolCallId);
        if (!tool) {
          // Older-history windows can start with the result of a call outside the window.
          tool = line(new ToolExecutionComponent(message.toolName, message.toolCallId, {}, { showImages: false }, undefined, this.tui, cwd), message.toolName, {});
          components.push(tool);
        }
        tool.update({ ...message, content: cleanContent(message.content) as typeof message.content, isError: message.isError ?? false });
      }
    }
    this.transcript = components;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    if (this.detailId) this.offset = Math.max(0, this.offset - event.wheelDelta);
    else if (this.entries.length) {
      this.index = Math.max(0, Math.min(this.entries.length - 1, this.index + Math.sign(event.wheelDelta)));
      this.selectedId = this.entries[this.index]?.id;
      this.scheduleRefresh();
    }
    return { handled: true };
  }

  handleInput(data: string) {
    const matches = (key: Parameters<KeybindingsManager["matches"]>[1]) => this.keys.matches(data, key);
    if (this.inputMode) {
      if (matches("tui.select.cancel")) { this.inputMode = false; this.input.focused = false; }
      else this.input.handleInput(data);
      this.tui.requestRender(); return;
    }
    const confirming = this.confirmCancel;
    this.confirmCancel = undefined;
    if (matches("tui.select.cancel") || matches("tui.editor.cursorLeft") || data === "h") {
      if (!this.detailId) return this.done(undefined);
      this.detailId = undefined; this.messages = []; this.transcript = []; this.metadata = undefined; this.historyLimit = 100; this.error = undefined; this.showInfo = false;
    } else if (!this.detailId && (data === "c" || data === "p")) return this.done(data === "c" ? "configure" : "preset");
    else if (data === "x") {
      // A single stray x must not kill a long-running job.
      const job = this.entries.find((job) => job.id === (this.detailId ?? this.selectedId));
      if (job && pendingJob(job) && this.jobs) {
        if (confirming === job.id) this.perform(() => this.jobs!.cancel(job.id));
        else this.confirmCancel = job.id;
      }
    } else if (this.detailId) {
      if (data === "i" || matches("tui.select.confirm")) { this.inputMode = true; this.input.focused = this.focused; }
      else if (data === "?") this.showInfo = !this.showInfo;
      else if (data === "k" || matches("tui.select.up")) this.offset += 6;
      else if (data === "j" || matches("tui.select.down")) this.offset = Math.max(0, this.offset - 6);
      else if (matches("tui.editor.pageUp")) this.offset += this.bodyHeight;
      else if (matches("tui.editor.pageDown")) this.offset = Math.max(0, this.offset - this.bodyHeight);
      else if (data === "g") this.offset = Number.MAX_SAFE_INTEGER;
      else if (data === "G") this.offset = 0;
      else if (data === "o") { this.historyLimit += 100; this.scheduleRefresh(); }
      else if (matches("app.tools.expand")) {
        this.toolsExpanded = !this.toolsExpanded;
        for (const component of this.transcript) if ("expanded" in component) (component as Expandable).expanded = this.toolsExpanded;
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
  private rows() { return Math.max(8, (this.tui.terminal.rows || 30) - 3); }

  render(width: number) {
    const theme = this.theme;
    const job = this.entries.find((job) => job.id === this.detailId);
    const lines = job ? this.renderDetail(job, width) : this.renderList(width);
    if (this.error) lines.push(theme.fg("error", terminalText(this.error)));
    return lines.map((line) => truncateToWidth(line, width));
  }
  private header(job: Job, width: number) {
    const theme = this.theme;
    const title = theme.fg(color(job), `${STATUS_ICONS[job.status] ?? "●"} `) + theme.fg("toolTitle", oneLine(job.title ?? job.task));
    return spread(title, theme.fg(color(job), statusLabel(job)) + theme.fg("dim", ` ${elapsed(job.startedAt, job.finishedAt ?? Date.now())}`), width);
  }
  private meta(job: Job) {
    const usage = this.metadataId === job.id ? usageText(this.metadata) : "";
    return this.theme.fg("dim", [`${job.name ?? job.agent}`, `${job.model}:${job.thinking}`, usage].filter(Boolean).join(" · "));
  }
  private cancelHint(job?: Job) {
    return job && this.confirmCancel === job.id ? this.theme.fg("warning", `press x again to cancel ${job.name ?? job.agent}`) : undefined;
  }
  private renderList(width: number) {
    const theme = this.theme, capacity = this.rows() - 3;
    const blocks = this.entries.map((job, index) => {
      const selected = index === this.index;
      if (!pendingJob(job)) {
        const line = `${selected ? theme.fg("accent", "❯") : " "} ${this.header(job, Math.max(1, width - 2))}`;
        return selected ? [line, `  ${this.meta(job)}`] : [line];
      }
      const activity = job.status === "waiting" || job.status === "stalled" || job.error
        ? [theme.fg(job.status === "waiting" ? "warning" : "muted", jobActivity(job))]
        : (this.jobs?.preview(job.id) ?? "").split("\n").filter((line) => line.trim()).slice(-2).map((line) => theme.fg("muted", oneLine(line)));
      const body = { invalidate() {}, render: (inner: number) => [this.header(job, inner), this.meta(job), ...activity].map((line) => truncateToWidth(line, inner)) };
      return framed(body, theme, selected ? "accent" : "borderMuted").render(width);
    });
    const lines: string[] = [];
    let selectedStart = 0, selectedEnd = 0;
    for (const [index, block] of blocks.entries()) {
      if (index === this.index) { selectedStart = lines.length; selectedEnd = lines.length + block.length; }
      lines.push(...block);
    }
    let start = Math.max(0, Math.min(selectedStart, lines.length - capacity));
    if (selectedEnd > start + capacity) start = selectedEnd - capacity;
    const shown = lines.slice(start, start + capacity);
    if (!this.entries.length) {
      shown.push("No jobs yet. Agents appear here when you delegate work.", "");
      for (const [name, agent] of Object.entries(getAgents()).slice(0, Math.max(0, capacity - 2))) shown.push(`${name} · ${agent.model}:${agent.thinking}`);
    }
    while (shown.length < capacity) shown.push("");
    const counts = ["waiting", "running", "stalled", "done", "failed", "cancelled"].flatMap((status) => {
      const count = this.entries.filter((job) => job.status === status).length;
      return count ? [`${STATUS_ICONS[status]} ${count}`] : [];
    }).join("  ");
    const footer = this.cancelHint(this.entries[this.index]) ??
      theme.fg("dim", `j/k select · enter open${pendingJob(this.entries[this.index] ?? { status: "done" } as Job) ? " · x cancel" : ""} · c configure · p preset · esc close`);
    return [spread(theme.bold(theme.fg("accent", "Subagents")) + theme.fg("dim", ` · preset ${getActiveSubagentPresetName()}`), theme.fg("dim", counts), width), "", ...shown, footer];
  }
  private renderDetail(job: Job, width: number) {
    const theme = this.theme;
    if (width < 12) return [truncateToWidth(this.header(job, width), width)];
    const inner = width - 4;
    const edge = (text: string) => theme.fg("borderMuted", text);
    const row = (line: string) => edge("│") + " " + pad(line, inner) + " " + edge("│");
    // A border with labels set into it, like ╭─ title ───── status ─╮.
    const rule = (left: string, right: string, title = "", tail = "") => {
      const room = width - 2;
      const label = title ? truncateToWidth(` ${title} `, Math.max(0, room - 2)) : "";
      const end = tail && visibleWidth(label) + visibleWidth(tail) + 4 <= room ? ` ${tail} ` : "";
      const fill = Math.max(0, room - 1 - visibleWidth(label) - visibleWidth(end) - (end ? 1 : 0));
      return edge(left + "─") + label + edge("─".repeat(fill)) + end + (end ? edge("─") : "") + edge(right);
    };
    const wrap = (text: string, tone: Parameters<Theme["fg"]>[0]) => wrapTextWithAnsi(theme.fg(tone, text), Math.max(1, inner));

    const top = [rule("╭", "╮", theme.fg("accent", "‹ ") + theme.fg("toolTitle", oneLine(job.title ?? job.task)),
      theme.fg(color(job), `${STATUS_ICONS[job.status] ?? "●"} ${statusLabel(job)}`) + theme.fg("dim", ` ${elapsed(job.startedAt, job.finishedAt ?? Date.now())}`)), row(this.meta(job))];
    if (this.showInfo) top.push(...[
      `${job.name ?? job.id} · started ${clock(job.startedAt)} · ended ${clock(job.finishedAt)} · ${shortPaths(job.cwd)}`,
      `Conversation ${job.conversationId} · latest ${this.historyLimit} entries · o older`,
      "j/k or wheel scroll · g/G top/bottom · ctrl+o tools · ctrl+t thinking · i message",
    ].flatMap((line) => wrap(line, "dim")).map(row));

    // Pinned below the transcript so the current state stays visible while scrolling.
    const pinned: string[] = [];
    // The transcript already contains partial assistant text. Show only the
    // current tool/retry state here, not a second copy of the streamed answer.
    const activity = jobActivity(job, this.jobs?.preview(job.id));
    if (activeJob(job) && (!this.messages.length || /^(Running |Retrying:|Compacting context|Waiting for model|Stalled)/.test(activity))) pinned.push(...wrap(`● Now · ${oneLine(activity)}`, "muted"));
    for (const item of this.metadata?.queued ?? []) if (item.mode !== "write") {
      const content = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
      pinned.push(...wrap(`Queued · ${oneLine(content)}`, "warning"));
    }
    if (job.question) pinned.push(...wrap(`? ${terminalText(job.question.text)}`, "warning"));
    if (job.error) pinned.push(...wrap(terminalText(job.error), "error"));
    if (this.inputMode) pinned.push(theme.fg("accent", job.status === "waiting" ? "Answer the child's question" : "Send guidance or follow-up"), ...this.input.render(inner));
    else pinned.push(theme.fg("dim", `› i to ${job.status === "waiting" ? "answer" : pendingJob(job) ? "steer" : "follow up"}`));

    const body = this.transcript.flatMap((component) => component.render(inner));
    const height = this.bodyHeight = Math.max(3, this.rows() - top.length - pinned.length - 3);
    this.offset = Math.min(this.offset, Math.max(0, body.length - height));
    const end = body.length - this.offset;
    const shown = body.slice(Math.max(0, end - height), end);
    while (shown.length < height) shown.push("");
    const below = this.offset ? theme.fg("accent", `↓ ${this.offset} lines below · G follow`) : "";
    const keys = this.cancelHint(job) ?? theme.fg("dim", this.inputMode ? "enter send · esc cancel" : `ctrl+o tools · ? more${pendingJob(job) ? " · x cancel" : ""} · esc back`);
    return [...top, rule("├", "┤"), ...shown.map(row), rule("├", "┤", "", below), ...pinned.map(row), rule("╰", "╯", keys)];
  }
}

export function showAgents(ctx: ExtensionContext, jobs?: AgentJobs, initialId?: string) {
  return ctx.ui.custom<Action>((tui, theme, keys, done) => new Dashboard(tui, theme, keys, jobs, done, initialId), {
    overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
  });
}
