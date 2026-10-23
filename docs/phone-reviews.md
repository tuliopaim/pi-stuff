# Plannotator reviews on your phone

Enabled on homelab, MacBook, and Mac mini. Existing Pi sessions need `/reload` once when idle. New Pi sessions load the integration automatically.

## Use it

With Tailscale connected on your phone, open Pi through Herdr Web UI. In the Pi prompt, use a normal Plannotator command:

```text
/plannotator-last
/plannotator-review
/plannotator-annotate path/to/document.md
```

Plans submitted through Plannotator plan mode also work. A message appears in the same Pi conversation with **Open review on your phone**. Open it in another browser tab, then annotate, approve, or send feedback normally. Feedback returns through Plannotator to the Pi session that opened the review.

Run `/phone-reviews` to list this session's open review links or retry publishing after Tailscale was offline. Review links use the machine hosting Pi and a port chosen for that review; they are not permanent bookmarks.

The native desktop browser continues to work. Each open review has its own link. Closing a review removes its link. Reloading Pi preserves links for reviews that Plannotator itself keeps open. Quitting Pi removes its links.

## Setup

The addon is `agent/extensions/plannotator-phone/`, loaded through the existing personal extension directory. It uses Plannotator's process review registry, covering its native commands and tools. The installed Plannotator package is unchanged.

Machine-local opt-in configuration is shared by personal and work Pi profiles:

```json
{
  "enabled": true,
  "tailscale": "/usr/bin/tailscale"
}
```

Save it as `~/.config/pi/plannotator-phone.json`. The Macs use `/usr/local/bin/tailscale` for `tailscale` instead. Set `enabled` to `false` and reload Pi to disable phone links.

The addon sets `PLANNOTATOR_REMOTE=0` inside Pi so new native review servers bind to localhost, including sessions started through SSH. Each review gets a separate localhost proxy. Tailscale Serve publishes that proxy over HTTPS in the tailnet; the proxy admits only the Tailscale login that owns the machine. It checks browser origins and forwards requests to the original review server using that server's localhost Host and Origin, preserving Plannotator's native feedback and Ask this session behavior.

The addon uses foreground Serve sessions, leaving existing T3, Herdr, and other routes intact. It stops its CLI process group on cleanup, including the child of the Macs' Tailscale shell launcher. Normal Pi shutdown also cleans up. A forced process kill or machine crash can bypass cleanup; stale foreground CLI processes may need stopping if that happens.

## Validation

Validated with Pi 1.3.0 and Plannotator Pi extension 0.28.17 on homelab; both Macs' installed 0.28.23 extensions expose the same review registry. Owner-authenticated HTTPS reads, feedback submissions, and route cleanup passed on all three machines. Mac mini also passed a request originating on homelab.

A disposable Pi session opened an actual annotation review. Its link appeared in the native Herdr chat transcript, survived `/reload`, and delivered submitted feedback to the same Pi PID. A deterministic local provider handled the resulting turn; no paid model request was used.

The 13 tests cover ownership and origin checks, feedback forwarding, streaming, WebSocket upgrades, rejected targets, Serve conflicts, reload behavior, publishing races, session ownership, failed UI notifications, and process cleanup after the Mac launcher exits. Run:

```sh
cd ~/dotfiles/pi/agent
node --test --experimental-strip-types ../tests/plannotator-phone.test.ts
./node_modules/.bin/tsc --project extensions/plannotator-phone/tsconfig.json
```
