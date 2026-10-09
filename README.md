# Vibe Terminal Background

State-driven looping video background (local MP4/WebM + TikTok playlist) behind the
**VS Code Integrated Terminal only** — the editor and every other UI surface stay untouched.

When an AI agent is **thinking**, the video plays bright with audio. When it becomes
**interactive** (asking you a question, or done), the video dims and mutes so terminal
text is 100% readable. Everything is driven by a localhost state bridge, so agents are
never modified beyond a one-line fire-and-forget hook.

```text
agent event ──curl──▶ bridge 127.0.0.1:47832 ──SSE──▶ injected runtime ──▶ video/audio/vis
 (opencode/claude/codex/pi)                            (inside the terminal DOM only)
```

## How it works

1. **One-time workbench patch** — on first activation the extension backs up VS Code's
   `workbench.html` and injects a small runtime (CSP-compatible). `Unpatch / Repair`
   restores the original byte-for-byte. VS Code updates are re-patched automatically on
   the next activation.
2. **State bridge** — the extension hosts `POST /v1/state`, `GET /v1/events` (SSE),
   `GET /v1/config`, `POST /v1/log` and `GET /v1/media/*` on **127.0.0.1 only**.
3. **Harness adapters** — optional one-command installs write a tiny hook into your
   agent (Claude Code, Codex, OpenCode, pi) that reports `thinking` / `interactive`.
   Each file carries a marker block; uninstall restores backups byte-for-byte or
   deletes files the adapter itself created.
4. **Injected runtime** — mounts a video layer behind the terminal's xterm surface,
   applies per-state opacities, handles TikTok `postMessage` audio, playlist rotation,
   pause/resume when the terminal is hidden, and an SSE self-healing reconnect.

## States

| State | Trigger | Video | Audio (`stateful` mode) |
|---|---|---|---|
| `thinking` | agent streaming / calling tools | bright (0.85), text dimmed (0.4) | unmuted (local video) |
| `interactive` | agent asks a question / idle / default | dimmed (0.15), text fully readable | muted |

- Default state is **interactive** — text is readable with no adapter installed.
- **Idle fallback** (`vibeTerminal.stateIdleFallbackSec`, default 300 s): the timer
  resets on *every* hook event, so an actively working agent never trips it. It only
  fires when the agent goes completely silent (crash, lost hook, hang) and would
  otherwise leave the terminal stuck dimmed with audio playing.
- **Playlist**: 1 entry loops natively; 2+ entries rotate on the official TikTok
  `ended` event (local MP4/WebM mixed freely with TikTok URLs).
- **Audio** is best-effort per browser rules: the **TikTok iframe is always muted**
  (it pauses itself if the host unmutes outside a user gesture — verified), so
  `stateful`/`unmuted` apply to **local MP4/WebM** only; `audio: "muted"` forces
  silence everywhere.

## Commands

| Command | Description |
|---|---|
| `Vibe Terminal: Set Background` | Pick a local MP4/WebM file |
| `Vibe Terminal: Set TikTok Background` | Use a TikTok URL as background |
| `Vibe Terminal: Add TikTok to Playlist` / `Remove from Playlist` | Manage entries |
| `Vibe Terminal: Show Playlist` | List every entry (▶ = currently playing) with remove/copy/settings actions |
| `Vibe Terminal: Clear / Toggle / Reload Background` | Day-to-day control |
| `Vibe Terminal: Install / Uninstall Harness Adapters` | Agent hooks (QuickPick: claude, codex, opencode, pi, all) |
| `Vibe Terminal: Simulate Thinking` / `Simulate Interactive` | Preview states without any agent |
| `Vibe Terminal: Unpatch / Repair` | Restore the original workbench file |

## Settings

| Setting | Default | Description |
|---|---|---|
| `vibeTerminal.enabled` | `true` | Master switch |
| `vibeTerminal.playlist` | `[]` | Ordered local paths / TikTok URLs (≥1 entry required) |
| `vibeTerminal.fit` | `cover` | `cover` \| `contain` \| `fill` |
| `vibeTerminal.loop` | `true` | Loop local videos |
| `vibeTerminal.audio` | `stateful` | `stateful` \| `muted` \| `unmuted` |
| `vibeTerminal.transitionMs` | `350` | Fade duration between states (0–5000) |
| `vibeTerminal.states` | see below | Per-state `videoOpacity` / `overlayOpacity` / `textOpacity` |
| `vibeTerminal.bridgePort` | `47832` | Localhost bridge port (1024–65535) |
| `vibeTerminal.stateIdleFallbackSec` | `300` | Silent-event timeout before reverting stuck `thinking` (10–86400) |

```json
{
  "vibeTerminal.states": {
    "thinking":    { "videoOpacity": 0.85, "overlayOpacity": 0.10, "textOpacity": 0.40 },
    "interactive": { "videoOpacity": 0.15, "overlayOpacity": 0.55, "textOpacity": 1.00 }
  }
}
```

## Multiple VS Code windows (independent instances)

Open **two different folders** in two VS Code windows and each gets its own background:

- **Per-window bridge.** Each window scans upward from `vibeTerminal.bridgePort` (`47832`, `47833`, …) and binds the first free port. The bound port is published in that window's status bar as `vibe-bridge:<port>`, which the injected runtime reads to connect to **its own** bridge — never a sibling's.
- **Per-folder config.** `playlist` and `enabled` are written to the **workspace** scope (`.vscode/settings.json` of the folder open in that window), so setting a video in one folder never overwrites another. An empty window falls back to the user scope.
- **Shared workbench is neutral.** The patched `workbench.html` is shared by every window on the machine, so it only embeds a neutral bootstrap (`enabled:false`, empty playlist, base port). Real config and the real port arrive over each window's own SSE bridge — that is what keeps two instances from fighting over the one shared file.

> Agent event routing (which window a `thinking`/`interactive` hook reports to) is per-window for the **state** visuals once each window has its own bridge, but the harness adapters are still installed with a single port. Run *Install Harness Adapters* in the window that should react to your agent.

## Harness adapters

| Harness | File touched | Behavior |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | merges `Stop`/`Notification`-style hooks, preserves your data |
| Codex | `~/.codex/hooks.json` + `config.toml` | TOML marker block sets `[features] codex_hooks = true` |
| OpenCode | `~/.config/opencode/plugins/vibe-state.ts` | fully owned file; bus events → POST |
| pi | `~/.pi/agent/hooks/vibe-state.ts` | fully owned file; PostToolUse/Notification → POST |

Safety rules shared by all adapters:

- existing files are backed up to `<file>.vibe-terminal.bak` before any edit;
- a file **without** our marker is never overwritten (your content is sacred);
- uninstall restores backups byte-for-byte, and deletes only files the adapter created;
- hooks are fire-and-forget `curl` with a 1 s timeout — a dead bridge can never block
  or break your agent.

OpenCode event mapping: `message.part.updated`, `tool.execute.before/after`,
`permission.replied` → `thinking`; `session.idle`, `permission.asked` → `interactive`.

## Install

```powershell
# from a built VSIX
code --install-extension vibe-terminal-background-0.1.0.vsix
```

Or build it yourself:

```powershell
npm install
npm run package        # typecheck + lint + 50 tests, then .vsix in the repo root
```

Then reload VS Code, run `Vibe Terminal: Set Background`, and (optionally)
`Vibe Terminal: Install Harness Adapters`.

## Development

```powershell
npm run build        # bundle dist/ (extension + injected runtime)
npm run watch        # rebuild on change
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # node:test suite (50 tests, 11 suites)
node poc\run-dev.mjs # headless integration run against a scratch VS Code profile
```

`poc/run-dev.mjs` launches VS Code with a disposable profile, verifies the patch,
SSE snapshot, terminal mount, transparency/stacking probes, audio round-trip, and
playlist rotation (local clip → TikTok), then prints a PASS/FAIL verdict per check.

## Requirements & limitations

- Verified on **VS Code 1.141** (Windows). Requires `^1.95.0` APIs.
- Requires `terminal.integrated.gpuAcceleration: "off"` (DOM renderer) — the WebGL
  renderer paints an opaque canvas over the video. The extension sets it to `"off"`
  automatically on activation (and warns if you force it `"on"`).
- The workbench file is patched once (backup taken). VS Code updates may re-trigger
  the patch on next activation; use `Unpatch / Repair` to revert at any time.
- Video is mounted **only** behind the Integrated Terminal — editors, diff views and
  other panels are unaffected. If integration ever fails, the terminal degrades to
  normal (the extension never breaks it).
- TikTok playback requires network access; `www.tiktok.com` must be reachable.
- The bridge binds `127.0.0.1` exclusively; nothing is exposed to the network.

## Specification

Full design (12-phase plan, hooks protocol, visuals, acceptance checklist):
`vibe-terminal-background-spec.md` (in the repository root).

Step-by-step installation & testing guide (Vietnamese): `HUONG_DAN.md`.

## License

MIT — see `package.json`.
