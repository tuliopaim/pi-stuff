# Selection comments prototype

The requested interaction is possible inside fullscreen Pi, without changing Herdr. The prototype is `agent/extensions/selection-comments-prototype.ts`.

## Try it

From any project, start Pi with the additional extension:

```sh
pi -e /Users/tuliopaim/dotfiles/pi-selection-comments/agent/extensions/selection-comments-prototype.ts
```

1. Use fullscreen mode, selectable through `/settings`.
2. Drag-select some transcript text. A small Cite button appears beside the end of the selection.
3. Click Cite and type a comment.
4. Click Send, or press Enter or Ctrl+Enter. Shift+Enter inserts a newline. Escape cancels.

`/cite` or Alt+Shift+C opens the comment popup for the last captured selection. Copy-on-select continues to work. Nothing reaches the agent until you send. Messages go to the same Pi session and wait as follow-ups if the agent is busy.

The comment card has a single rounded border, a neutral background, and a quote preview limited to two rows. The preview may shorten long passages; sending always includes the full quote. Send stays dim until the comment contains text. The card opens below the selection when there is room, otherwise above it.

This is a terminal popup, not a native macOS popover. It works with Pi-owned mouse selection, not selection performed by the outer terminal or Herdr's scrollback. Comments are not saved across session shutdown. There is no comment batching.

## Pi compatibility

Research and the initial in-memory check used installed Pi 1.0.4. Fullscreen Pi already supports mouse selection, clickable components, and overlays positioned in terminal rows and columns. Its default `fullscreenCopyOnSelect` is `true`.

Sources:

- [Pi terminal UI documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md).
- Installed `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`, Terminal and display.
- Installed `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.d.ts:85-96` exposes selection detection and clipboard copying, but not selected text.

The extension uses two private Pi internals: `handleViewportInput` and `getActiveSelectionText`. The first observes selection completion; the second reads Pi's exact selected text without reading or polling the clipboard. The adapter checks for both methods and disables itself with a warning if they disappear. It restores its input handler on disposal and reattaches after renderer changes.

An ordinary `ctx.ui.onTerminalInput` listener cannot do this today: fullscreen's first input listener consumes mouse reports before extension listeners receive them. An in-memory check confirmed this, exact quote extraction, overlay positioning, and mouse clicks on the overlay.

Evidence: installed `pi-tui/dist/tui-alt-screen.js:105,470-520,1195-1220` and `pi-tui/dist/tui.js:678-699`.

A supported version should replace the adapter with a public selection-completed event carrying the selected text and terminal coordinates. Pi upgrades can break the prototype despite the method checks.

## Validation

The prototype tests cover exact quote capture, a second selection before repaint, mouse Send/Cancel and editor cursor placement, Enter and Ctrl+Enter, multiline comments, expanded pastes, narrow widths, card borders and backgrounds, safe disposal, unsupported hosts, and preserving comments if delivery fails.

```sh
npm test --prefix /Users/tuliopaim/dotfiles/pi-selection-comments/agent
```

Strict TypeScript checking passed for the extension. A separate in-memory smoke test used the installed Pi 1.0.4 extension loader and its real forwarding TUI proxy. It exercised mouse selection, Cite, comment submission, regular/fullscreen renderer replacement, and cleanup. No real agent request or clipboard change was made. The user confirmed the initial prototype works in Herdr; the revised card still needs a live visual check.

## Herdr findings

Installed Herdr reports 0.9.3. The local Herdr source checkout reports 0.7.1, so research used official 0.9.3 source rather than assume that checkout matches the running app.

When a pane application enables mouse reporting, Herdr forwards press, drag, and release events with pane-relative coordinates. That is enough for Pi's fullscreen interaction.

Evidence: [Herdr 0.9.3 mouse handling](https://github.com/herdrdev/herdr/blob/v0.9.3/src/client/shell/mouse.rs), lines 843-875, 2198-2241, and 2309-2368.

Herdr plugins support selected-text handoff, terminal popups, and explicit agent delivery. They do not expose a general selection-release event or selection-anchored popup positioning. `pane.selection.read` requires caller-supplied anchor and cursor coordinates; it does not discover the current client selection.

Evidence: [pane schema](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/panes.rs), [event schema](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/events.rs), and [plugin schema](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/plugins.rs).

Plannotator's upstream [Herdr Annotate plugin](https://github.com/plannotator/herdr-annotate/tree/e3ca7e88ada0c77baf5714c006a5abe36798349c) provides capture, a separate terminal comment editor, and explicit paste/send actions. It does not add a nearby Cite button when selecting text in the original pane. The read-only plugin listing for the inspected session returned no registered plugins, even though the dotfiles contain Annotate bindings.

No installed Pi files, Herdr configuration, or running sessions were changed during research or implementation.
