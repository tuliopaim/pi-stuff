# Selection comments prototype

The requested interaction is possible inside fullscreen Pi, without changing Herdr. The prototype is `agent/extensions/selection-comments-prototype.ts`.

## Try it

From any project, start Pi with the additional extension:

```sh
pi -e /Users/tuliopaim/dotfiles/pi-selection-comments/agent/extensions/selection-comments-prototype.ts
```

1. Use fullscreen mode, selectable through `/settings`.
2. Drag-select some transcript text, then click Comment, right-click the selection, or press F6.
3. Type a comment. Click Save, or press Enter or Ctrl+S, to save it without sending. The card closes and the list stays hidden.
4. Select another passage and add a note. The card shows your saved notes below the new comment.
5. Click Send all or press Ctrl+Enter to send one message containing the saved notes and any current comment. The next card starts with an empty list.

Shift+Enter inserts a newline. Escape or Cancel discards only the current draft, not saved notes. Click × beside a saved note to delete it. Tab switches between editing and the list; use Up/Down and Delete or Backspace to remove a selected note. Long lists scroll with the mouse wheel.

Outside the card, a quiet row above the main editor shows the saved count, Review, and Send all. Both actions are clickable. F7 or `/notes` opens the list; F8 or `/notes send` sends the saved batch. `/cite` adds another note using the last captured selection.

On a Mac, use Fn/Globe with F6, F7, or F8 if those keys normally control system functions. The extension does not bind Option/Alt shortcuts.

Copy-on-select continues to work. Nothing reaches the agent until you explicitly send. Messages go to the same Pi session and wait as follow-ups if the agent is busy.

The card keeps its single rounded border and neutral background. The current quote takes at most two rows. Saved notes show short quote/comment previews, at most three notes at a time, with a delete control on each. Short windows use compact previews to keep the buttons visible. Sending always includes full quotes and comments, oldest first. Send stays dim when both the list and draft are empty.

Saved notes use custom Pi session entries, excluded from model context, so they survive reload and resume and follow the active session branch. Pi's public send API has no delivery acknowledgement. The list clears when the message is handed to Pi; if Pi later rejects delivery, `/notes recover` restores the last submitted batch for review. Check the transcript before resending to avoid duplicates.

This is a terminal popup, not a native macOS popover. It works with Pi-owned mouse selection, not selection performed by the outer terminal or Herdr's scrollback.

## Pi compatibility

Research and the initial in-memory check used installed Pi 1.0.4. Batch work also checks the currently installed Pi 1.1.0. Fullscreen Pi already supports mouse selection, clickable components, and overlays positioned in terminal rows and columns. Its default `fullscreenCopyOnSelect` is `true`.

Sources:

- [Pi terminal UI documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md).
- Installed `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`, Terminal and display.
- Installed `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.d.ts:85-96` exposes selection detection and clipboard copying, but not selected text.

The extension uses two private Pi internals: `handleViewportInput` and `getActiveSelectionText`. The first observes selection completion; the second reads Pi's exact selected text without reading or polling the clipboard. The adapter checks for both methods and disables itself with a warning if they disappear. It restores its input handler on disposal and reattaches after renderer changes.

An ordinary `ctx.ui.onTerminalInput` listener cannot do this today: fullscreen's first input listener consumes mouse reports before extension listeners receive them. An in-memory check confirmed this, exact quote extraction, overlay positioning, and mouse clicks on the overlay.

Evidence: installed `pi-tui/dist/tui-alt-screen.js:105,470-520,1195-1220` and `pi-tui/dist/tui.js:678-699`.

A supported version should replace the adapter with a public selection-completed event carrying the selected text and terminal coordinates. Pi upgrades can break the prototype despite the method checks.

## Validation

The prototype tests cover exact quote capture, right-click capture, repeated selections, mouse Save/Send/Cancel/Delete, keyboard save and batch send, bounded list scrolling, editor cursor placement, multiline comments, expanded pastes, narrow widths, card borders and backgrounds, safe disposal, unsupported hosts, branch restoration, reload, recovery, and storage/delivery failures.

```sh
npm test --prefix /Users/tuliopaim/dotfiles/pi-selection-comments/agent
```

Strict TypeScript checking passed for the extension and tests. The single-comment version also passed an in-memory smoke test using Pi 1.0.4's real loader and forwarding TUI proxy, including dark/light themes. The user confirmed that version works well in Herdr.

The batch version passed the same kind of smoke test with installed Pi 1.1.0 and its real dark/light themes: right-click capture, shortcut registration, Save, review, Delete, batch send, recovery, renderer replacement, and cleanup. Checks at 8, 10, and 24 terminal rows also verified visible buttons and rejection of dialog results resolved before a branch change. No real agent request or clipboard access was made. The batch version still needs a live mouse check.

## Herdr findings

Installed Herdr reports 0.9.3. The local Herdr source checkout reports 0.7.1, so research used official 0.9.3 source rather than assume that checkout matches the running app.

When a pane application enables mouse reporting, Herdr forwards press, drag, and release events with pane-relative coordinates. That is enough for Pi's fullscreen interaction.

Evidence: [Herdr 0.9.3 mouse handling](https://github.com/herdrdev/herdr/blob/v0.9.3/src/client/shell/mouse.rs), lines 843-875, 2198-2241, and 2309-2368.

Herdr plugins support selected-text handoff, terminal popups, and explicit agent delivery. They do not expose a general selection-release event or selection-anchored popup positioning. `pane.selection.read` requires caller-supplied anchor and cursor coordinates; it does not discover the current client selection.

Evidence: [pane schema](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/panes.rs), [event schema](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/events.rs), and [plugin schema](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/plugins.rs).

Plannotator's upstream [Herdr Annotate plugin](https://github.com/plannotator/herdr-annotate/tree/e3ca7e88ada0c77baf5714c006a5abe36798349c) provides capture, a separate terminal comment editor, and explicit paste/send actions. It does not add a nearby Cite button when selecting text in the original pane. The read-only plugin listing for the inspected session returned no registered plugins, even though the dotfiles contain Annotate bindings.

The batch workflow follows [Herdr Annotate's current usage](https://github.com/plannotator/herdr-annotate#annotate-terminal-text): Ctrl+S saves, sending is separate, a manager lists/removes notes, and numbered annotations reach the agent oldest first. Pi's version stays inside the existing card and adds no Herdr plugin or dependency.

No installed Pi files, Herdr configuration, or running sessions were changed during research or implementation.
