import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const REQUIRED_PRESSES = 3;
const MAX_INTERVAL_MS = 1_000;

export class ConsecutivePressGate {
  private count = 0;
  private lastPressAt = 0;
  private readonly requiredPresses: number;
  private readonly maxIntervalMs: number;

  constructor(
    requiredPresses = REQUIRED_PRESSES,
    maxIntervalMs = MAX_INTERVAL_MS,
  ) {
    this.requiredPresses = requiredPresses;
    this.maxIntervalMs = maxIntervalMs;
  }

  press(now = Date.now()) {
    if (this.lastPressAt === 0 || now - this.lastPressAt > this.maxIntervalMs) {
      this.count = 0;
    }

    this.lastPressAt = now;
    this.count += 1;

    if (this.count < this.requiredPresses) return false;

    this.reset();
    return true;
  }

  reset() {
    this.count = 0;
    this.lastPressAt = 0;
  }
}

class TripleEscapeEditor extends CustomEditor {
  private readonly interruptGate = new ConsecutivePressGate();
  private readonly appKeybindings: KeybindingsManager;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    appKeybindings: KeybindingsManager,
  ) {
    super(tui, theme, appKeybindings);
    this.appKeybindings = appKeybindings;
  }

  override handleInput(data: string) {
    if (!this.appKeybindings.matches(data, "app.interrupt")) {
      this.interruptGate.reset();
      super.handleInput(data);
      return;
    }

    if (this.isShowingAutocomplete()) {
      this.interruptGate.reset();
      super.handleInput(data);
      return;
    }

    if (this.interruptGate.press()) super.handleInput(data);
  }
}

export default function tripleEscape(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new TripleEscapeEditor(tui, theme, keybindings),
    );
  });
}
