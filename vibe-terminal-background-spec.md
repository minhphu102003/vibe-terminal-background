# Vibe Terminal Background — Full Implementation Specification

## 1. Project Overview

Build a small VS Code extension tentatively named:

**Vibe Terminal Background**

The extension adds a state-driven looping video background to the **VS Code Integrated Terminal only**.

The intended workflow is "vibe coding":

- OpenCode / Codex / Claude Code / pi (and other CLI agents) run normally in the real Integrated Terminal.
- A looping video playlist (at least 1 configured entry) plays behind the terminal text — TikTok videos stream through the official embedded player, nothing is downloaded.
- The background reacts to the agent's state (see §15):

```text
thinking      video clearly visible, terminal text dimmed, audio allowed (stateful)
interactive   agent asks a question or shows results → video dimmed, text fully readable
```

- Terminal text remains fully interactive and readable at all times.
- The VS Code Editor is completely unaffected.
- The user can keep the editor available for reviewing diffs.
- The video automatically resizes when the terminal is resized.

Target visual:

```text
┌──────────────────────────────────────────────────────┐
│                 VS CODE                              │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │              INTEGRATED TERMINAL              │  │
│  │                                                │  │
│  │       [ looping video background ]            │  │
│  │                                                │  │
│  │  $ opencode                                    │  │
│  │  > analyzing repository...                     │  │
│  │  > editing files...                             │  │
│  │  > running tests...                             │  │
│  │                                                │  │
│  │  $                                             │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│                 Editor = untouched                   │
└──────────────────────────────────────────────────────┘
```

---

# 2. Core Requirements

## 2.1 Terminal-only

The video must appear **only inside the Integrated Terminal**.

Do NOT apply the video background to:

- Editor
- Explorer
- Sidebar
- Activity Bar
- Source Control
- Settings
- Command Palette
- Other VS Code panels

The editor must remain completely normal.

---

## 2.2 Real Integrated Terminal

Do NOT create a fake terminal.

Do NOT replace the terminal with a Webview-based terminal.

Do NOT implement a custom shell UI.

The existing VS Code Integrated Terminal must remain the actual terminal.

The following must continue working normally:

- PowerShell
- CMD
- Git Bash
- WSL
- OpenCode
- Hermes
- Claude Code
- other CLI applications
- terminal input
- terminal scrolling
- ANSI colors
- cursor
- interactive prompts
- keyboard shortcuts

The extension only adds a visual background layer.

---

## 2.3 Harness-Aware Behavior

The background reacts to coding-agent lifecycle state:

```text
thinking     agent is processing a prompt / running tools / streaming output
interactive  agent asks a question, requests permission, or shows final results
```

Requirements:

- Default state is `interactive`: with no adapter installed, terminal text stays fully readable.
- State changes affect visuals only (video/overlay/text opacity, audio). They never block or alter terminal input, output, scrolling, focus, or ANSI rendering.
- State transitions are smooth CSS fades (default 350ms), never hard cuts.
- The four primary harnesses are OpenCode, Codex, Claude Code, and pi (event mapping in §15).

---

# 3. Important VS Code API Constraint

Before implementing anything, investigate the current VS Code extension API.

Important:

VS Code extensions do not have unrestricted access to the Workbench DOM.

Do NOT assume that an extension can simply do:

```js
document.querySelector('.terminal')
```

or inject arbitrary HTML into the existing terminal.

The implementation must first determine the least invasive viable approach for placing a video behind the existing Integrated Terminal.

If the only viable approach requires a Workbench DOM/CSS injection or another unsupported/internal workaround:

1. Isolate the workaround in one module.
2. Document exactly what internal behavior it depends on.
3. Detect unsupported VS Code versions when possible.
4. Fail gracefully.
5. Never break terminal functionality.
6. Do not silently modify unrelated VS Code UI.

The terminal always has higher priority than the visual effect.

## Current Decision (Phase 1 Technical Decision Record)

```text
Approach:  Patch the workbench HTML shell on disk with a marker-delimited block
           (CSP extension + config JSON + external runtime <script>), the same
           technique used by established background extensions (shalldie/background).
           The injected runtime mounts the video layer inside the terminal container.
Why:       VS Code exposes no API to place content behind the Integrated Terminal,
           and the extension host has no access to the workbench DOM.
Isolation: src/patch/workbenchPatcher.ts is the ONLY module allowed to touch install files.
Safety:    original file backed up before patch; re-patch on every activation;
           product.json checksum entry for the patched file recomputed
           (base64(sha256(bytes)), padding stripped) so no corrupt warning appears;
           "Vibe Terminal: Unpatch / Repair" restores the original file;
           fallback if anything fails: unpatch → extension disabled → terminal normal.
PoC gate:  PASSED — see PoC results below.
Fallback:  unpatch install file → extension disabled → terminal fully normal.
```

### PoC Results (Phase 1, tested)

```text
VS Code versions tested: 1.140.0 (Windows x64)
Target file:             resources/app/out/vs/code/electron-browser/workbench/workbench.html
                         (workbench.desktop.main.html does NOT exist in this version;
                          patcher must locate workbench.html, with the legacy filename
                          as a fallback for older installs)
Scripts:                 script-src already allows 'self' → inject
                         <script src="./vibe-terminal-runtime.js"></script>, no CSP weakening
CSP extensions required: frame-src    += https://www.tiktok.com
                         connect-src  += http://127.0.0.1:<bridgePort>
                         media-src    += http://127.0.0.1:<bridgePort>   (local video served
                         by the bridge so no file: / blob: CSP games are needed)
Checksums:               product.json.checksums[<path relative to out/>] =
                         base64(sha256(file bytes)) with '=' padding stripped;
                         must be recomputed after every patch/unpatch
Trusted Types:           require-trusted-types-for 'script' is active → runtime must use
                         DOM APIs only (createElement/textContent), NEVER innerHTML
TikTok gate:             PASS — iframe loaded inside the workbench document, player
                         emitted onPlayerReady, onMute, onVolumeChange,
                         onStateChange(-1/3/1), onCurrentTime {currentTime, duration}
                         from origin https://www.tiktok.com; playback started (state 1)
Verified protocol shape: messages are { type: "<event>", value?: ..., x-tiktok-player: true }
PoC artifacts:           poc/run-poc.mjs (re-runnable gate), poc/verify-checksum.mjs
```

---

# 4. Architecture

Use a modular architecture.

Suggested structure:

```text
src/
├── extension.ts
│
├── bridge/
│   ├── stateServer.ts          # localhost HTTP: POST /v1/state, GET /v1/events (SSE)
│   └── stateMachine.ts         # thinking/interactive resolution, dedupe, idle fallback
│
├── patch/
│   ├── workbenchPatcher.ts     # ISOLATED workaround module: backup/patch/restore
│   └── manifest.ts             # marker block: <style> + config JSON + runtime script
│
├── injected/                   # bundled to plain JS, embedded in the patch block
│   ├── runtime.ts              # mount layer, SSE client, ResizeObserver
│   ├── player.ts               # TikTok iframe + official postMessage protocol
│   └── visuals.ts              # state → CSS vars (video/overlay/text opacity, audio)
│
├── adapters/
│   ├── claude.ts
│   ├── codex.ts
│   ├── opencode.ts
│   ├── pi.ts
│   └── common.ts               # marker blocks, backup/restore helpers
│
├── commands/
│   ├── setBackground.ts
│   ├── setTikTokBackground.ts
│   ├── playlist.ts             # add/remove playlist entries
│   ├── clearBackground.ts
│   ├── toggleBackground.ts
│   ├── reloadBackground.ts
│   ├── installAdapters.ts
│   ├── simulateState.ts
│   └── unpatch.ts
│
├── tiktok/
│   ├── parser.ts
│   ├── resolver.ts
│   └── types.ts
│
├── background/
│   ├── controller.ts
│   ├── lifecycle.ts
│   └── dimensions.ts
│
├── config/
│   └── settings.ts
│
└── utils/
    ├── cache.ts
    └── validation.ts
```

Keep the TikTok implementation independent from the terminal rendering implementation.
Keep the patch module isolated (§3): nothing outside `src/patch/` may reference install files.

---

# 5. Video Sources

The extension must support two source types in MVP.

## 5.1 Local video

Examples:

```text
C:\Videos\anime.mp4
D:\Vibe\background.webm
```

Supported formats should follow formats reliably playable by the chosen Chromium/video implementation.

At minimum target:

- MP4
- WebM

The implementation should not unnecessarily introduce FFmpeg.

---

## 5.2 TikTok URL

Example:

```text
https://www.tiktok.com/@username/video/123456789
```

The extension must recognize TikTok URLs and extract the post/video ID:

```text
123456789
```

Support normal TikTok video URLs first.

If shortened URLs or unusual TikTok URL formats are not reliable, document them rather than implementing fragile scraping.

---

## 5.3 Playlist

Backgrounds are configured as an ordered playlist:

```json
{
  "vibeTerminal.playlist": [
    "https://www.tiktok.com/@user/video/111111111",
    "https://www.tiktok.com/@user/video/222222222"
  ]
}
```

Rules:

```text
the playlist must contain at least 1 entry for the background to run
1 entry   → that video loops natively (loop=1)
2+ entries → videos play in order and rotate (see §6, Playlist Rotation)
local files and TikTok URLs may be mixed in the same playlist
removing the last entry is refused (or clears the background instead)
```

---

# 6. TikTok Implementation Strategy

## MVP: Official TikTok Player

Do NOT download TikTok videos in MVP.

Do NOT introduce:

- yt-dlp
- TikTok download APIs
- unofficial CDN extraction
- FFmpeg

unless explicitly required in a later phase.

Use TikTok's official Embedded Player.

Conceptually:

```text
TikTok URL
    ↓
Extract post ID
    ↓
Official TikTok Player
    ↓
Embedded player
    ↓
Terminal background
```

Player URL:

```text
https://www.tiktok.com/player/v1/{POST_ID}
```

Use supported player parameters for:

- autoplay
- loop
- muted
- hidden controls
- hidden fullscreen button
- hidden progress bar where supported

Target behavior:

```text
autoplay = true
loop = true              (single-entry playlist; multi-entry rotates instead — see below)
muted = true             (ALWAYS — see Audio; unMute is not used with the iframe)
controls = false
```

## Player Parameters

Append to the player URL:

```text
autoplay=1
controls=0
progress_bar=0
play_button=0
fullscreen_button=0
volume_control=0
timestamp=0
loop=1                   (single-entry playlist only)
muted=1                  (ALWAYS: loading with muted=0 lets TikTok autoplay once,
                          but any later unMute makes the embed PAUSE itself —
                          verified over CDP. The host only ever sends "mute")
```

## Player Messaging (official postMessage protocol)

Host → player (verified: messages must be OBJECTS tagged `x-tiktok-player: true`
— JSON strings are ignored — and are dropped until `onPlayerReady`):

```text
mute            set volume to 0   (the only audio command the host sends)
unMute          restore volume    (protocol-defined; NEVER sent — pauses the embed, see Audio)
seekTo          seek to seconds (not required in MVP)
```

Player → host — validate `event.origin === "https://www.tiktok.com"` before trusting:

```text
onPlayerReady
onStateChange       -1 init, 0 ended, 1 playing, 2 paused, 3 buffering
onMute              boolean
onVolumeChange      0-100
onCurrentTime       + duration
```

## Playlist Rotation

```text
1 entry     → loop=1, native repeat, no rotation logic
2+ entries  → loop=0; when onStateChange(0 = ended) fires, swap the iframe src
              to the next playlist entry; wrap around at the end
never guess duration or use timers — react only to official player events
if the ended event never arrives, fall back to the configured entry (document it)
```

## Audio (stateful)

```text
TikTok iframe              ALWAYS muted: loads with muted=1 and the host only
                            ever sends postMessage "mute".
                            Reason (verified over CDP): the embed pauses itself
                            as soon as the host sends unMute outside a user
                            gesture — autoplay with sound is blocked by browser
                            policy, so unMute would kill playback entirely.
local <video>              follows vibeTerminal.audio:
                            "stateful" (default) → unmute while thinking,
                                                   mute while interactive
                            "muted"               → always silent
                            "unmuted"             → always audible
commands sent before onPlayerReady are dropped by the embed → replay after ready
never error on mute failures — silent fallback
```

The extension should use the official player API/documentation rather than reverse-engineering TikTok.

---

# 7. TikTok Metadata

Use TikTok's official oEmbed endpoint when appropriate:

```text
https://www.tiktok.com/oembed?url=<VIDEO_URL>
```

The resolver should produce a normalized internal representation.

Example:

```ts
interface TikTokMetadata {
    id: string;
    originalUrl: string;

    title?: string;
    authorName?: string;

    width?: number;
    height?: number;

    thumbnailUrl?: string;

    playerUrl: string;
}
```

Example result:

```json
{
  "id": "123456789",
  "originalUrl": "https://www.tiktok.com/@user/video/123456789",
  "width": 720,
  "height": 1280,
  "playerUrl": "https://www.tiktok.com/player/v1/123456789"
}
```

Do not rely on the metadata dimensions for the final terminal rendering dimensions.

They are only source metadata.

---

# 8. Video Sizing and Responsive Rendering

This is a critical requirement.

Do NOT hard-code video dimensions.

Do NOT assume:

```text
720x1280
1920x1080
800x600
```

The video must dynamically fit the actual terminal viewport.

Conceptually:

```text
Actual terminal viewport
        ↓
Resize detection
        ↓
Video container
        ↓
width: 100%
height: 100%
        ↓
object-fit: cover
```

Recommended CSS behavior:

```css
.vibe-video {
    position: absolute;
    inset: 0;

    width: 100%;
    height: 100%;

    object-fit: cover;

    pointer-events: none;
}
```

The actual implementation may differ depending on the chosen VS Code integration mechanism.

---

# 9. Fit Modes

Expose:

```json
{
  "vibeTerminal.fit": "cover"
}
```

Supported values:

```text
cover
contain
fill
```

Default:

```text
cover
```

## cover

Fill the entire terminal viewport.

Crop the excess part while preserving aspect ratio.

This is the recommended default.

Example:

```text
9:16 TikTok
      ↓
16:9 terminal

┌───────────────────────────┐
│ █████████████████████████ │
│ █████████████████████████ │
│ █████████████████████████ │
└───────────────────────────┘
```

No distortion.

---

## contain

Show the entire video without cropping.

May leave empty areas.

---

## fill

Stretch video to terminal dimensions.

This may distort the aspect ratio.

Not recommended, but support it as an option if simple.

---

# 10. Dynamic Resize

The video must respond to terminal resizing.

Examples:

```text
Terminal:
1200x700
    ↓
1600x900
    ↓
2560x1400
```

The video must automatically follow the terminal viewport.

Do not require:

- reload
- restarting VS Code
- restarting the terminal
- manually pressing a refresh command

after resizing.

Prefer a real resize mechanism such as:

- ResizeObserver where technically possible
- terminal/Workbench resize events where appropriate
- another event-driven mechanism

Avoid aggressive polling.

---

# 11. Layering

Desired visual layer order:

```text
Layer 0: Video
Layer 1: Optional dark/theme overlay
Layer 2: Terminal/xterm content
```

The terminal text must always appear above the video.

The webgl/canvas terminal renderer is an EXCEPTION: it paints an opaque
`terminal.background` into a full-size `<canvas>` above the video, so the video
is invisible no matter the CSS. Requirement:

```text
terminal.integrated.gpuAcceleration = "off"   (DOM renderer — REQUIRED)
```

The extension sets it automatically on activation (auto/undefined → set Global
"off" + toast; "on" → warning with a fix button; "off" → silent). The runtime
diagnostic reports which renderer is active
(`renderer=dom (transparent — video visible)` vs
`renderer=webgl/canvas (OPAQUE canvas covers video ...)`).

The video must never intercept terminal mouse/keyboard input.

Equivalent behavior:

```css
pointer-events: none;
```

where applicable.

Target:

```text
VIDEO
  ↓
DARK OVERLAY
  ↓
TERMINAL TEXT
```

Never:

```text
VIDEO
  ↓
TERMINAL TEXT
```

with no readability protection.

---

# 12. Opacity and Readability

Three visual layers are state-driven (see §15):

```text
video layer opacity      vibeTerminal.states.<state>.videoOpacity
overlay layer opacity    vibeTerminal.states.<state>.overlayOpacity
terminal text opacity    vibeTerminal.states.<state>.textOpacity
```

Valid range:

```text
0.0 - 1.0
```

Default state table:

```text
state          videoOpacity   overlayOpacity   textOpacity
thinking            0.85           0.10           0.40
interactive         0.15           0.55           1.00
```

Text dimming is implemented as CSS opacity on the xterm container: text stays selectable and copyable, keyboard/mouse input is unaffected, and transitions fade smoothly over `vibeTerminal.transitionMs` (default 350).

The exact visual result must remain configurable per state.

Per-state goals:

```text
thinking       video clearly visible, text deliberately dimmed, audio allowed
interactive    video present but dim, terminal text 100% readable, no contrast problems
```

Fail-safe: whenever state resolution is unavailable (no adapter, bridge down), the `interactive` values apply — terminal text always stays readable.

---

# 13. Configuration

Add VS Code settings:

```json
{
  "vibeTerminal.enabled": true,

  "vibeTerminal.playlist": ["https://www.tiktok.com/@user/video/123456789"],

  "vibeTerminal.fit": "cover",

  "vibeTerminal.loop": true,

  "vibeTerminal.audio": "stateful",

  "vibeTerminal.transitionMs": 350,

  "vibeTerminal.bridgePort": 47832,

  "vibeTerminal.stateIdleFallbackSec": 300,

  "vibeTerminal.states": {
    "thinking": {
      "videoOpacity": 0.85,
      "overlayOpacity": 0.10,
      "textOpacity": 0.40
    },
    "interactive": {
      "videoOpacity": 0.15,
      "overlayOpacity": 0.55,
      "textOpacity": 1.00
    }
  }
}
```

`vibeTerminal.audio`:

```text
stateful   unmute while thinking, mute while interactive (default; local <video> only —
           the TikTok iframe is ALWAYS muted, see §6 Audio)
muted      always silent
unmuted    always audible, local <video> only (best-effort; TikTok iframe stays muted)
```

`vibeTerminal.bridgePort` / `stateIdleFallbackSec` are consumed by the state bridge (§15).

Potential future settings:

```text
vibeTerminal.playbackRate
vibeTerminal.blur
vibeTerminal.saturation
vibeTerminal.brightness
```

Do not overbuild these in MVP unless implementation is trivial.

---

# 14. Commands

Register these commands:

```text
Vibe Terminal: Set Background
Vibe Terminal: Set TikTok Background
Vibe Terminal: Add TikTok to Playlist
Vibe Terminal: Remove TikTok from Playlist
Vibe Terminal: Clear Background
Vibe Terminal: Toggle Background
Vibe Terminal: Reload Background
Vibe Terminal: Install Harness Adapters
Vibe Terminal: Uninstall Harness Adapters
Vibe Terminal: Simulate Thinking
Vibe Terminal: Simulate Interactive
Vibe Terminal: Unpatch / Repair
```

## Set Background

Show a Quick Pick:

```text
Local Video
TikTok URL
```

---

## Set TikTok Background

Prompt for:

```text
Paste TikTok URL
```

Example:

```text
https://www.tiktok.com/@user/video/123456789
```

Then:

```text
validate URL
    ↓
extract ID
    ↓
resolve metadata
    ↓
create official player
    ↓
display in terminal
```

---

## Clear Background

Immediately remove the background.

Terminal must return to its normal appearance.

---

## Toggle Background

Toggle:

```text
enabled
↔
disabled
```

The current video/source should remain configured when toggled off.

---

## Reload Background

Destroy and recreate the current player.

Useful for recovery after:

- network failures
- player initialization errors
- VS Code rendering problems

---

## Add TikTok to Playlist / Remove TikTok from Playlist

Add: prompt for a TikTok URL → validate → extract post ID → resolve/cache metadata (§7, §17) → append to `vibeTerminal.playlist`.

Remove: Quick Pick over current entries. Refusing to empty the playlist below 1 entry is allowed — clearing the last entry instead clears the background.

---

## Install Harness Adapters / Uninstall Harness Adapters

Quick Pick: `claude` / `codex` / `opencode` / `pi` / `all`.

Install backs up each target file and writes a marker-delimited block (§15.4). Uninstall removes the block and restores the backup when the file was newly created. Install is idempotent.

---

## Simulate Thinking / Simulate Interactive

Force a state without a running agent. Used to tune opacities/audio and to test the state bridge end to end.

---

## Unpatch / Repair

Restore the original workbench file from backup and re-apply a clean patch (§3). Emergency path when the injected runtime misbehaves; the terminal must remain usable throughout.

---

# 15. Harness Integration & State Bridge

The background is state-driven: it reacts to what the coding agent is doing.
Deep integration targets these four harnesses:

```text
OpenCode
Codex (OpenAI Codex CLI)
Claude Code
pi (badlogic / @mariozechner/pi-coding-agent)
```

## 15.1 States

Exactly two runtime states:

```text
thinking     agent is working (prompt submitted, tools running, streaming)
interactive  agent asks a question, requests permission, or shows results
```

Rules:

```text
Default state = interactive        (fail-safe: text always readable)
State changes are visual only      (never affect terminal input/output)
Transition is a CSS fade           (default 350ms)
State persists until next event    (no polling)
```

## 15.2 State Bridge

Communication channel between harness hooks and the workbench-injected runtime:

```text
harness hook ── POST /v1/state ──▶ extension host (state machine)
                                        │
                                   dedupe / throttle
                                   idle-fallback timer
                                        │
                                   GET /v1/events (SSE)
                                        │
                                        ▼
                          workbench injected runtime
                          applies visual state
```

Bridge contract:

```text
POST /v1/state        body: { "state": "thinking" | "interactive", "harness": "<name>" }
GET  /v1/events       Server-Sent Events stream of resolved state
```

Behavior:

```text
Listen on 127.0.0.1 only (never 0.0.0.0)
Port: vibeTerminal.bridgePort (default 47832)
Dedupe: identical consecutive states are dropped server-side
Throttle: high-frequency events (PreToolUse/PostToolUse) collapse to one update
Idle fallback: if state is thinking and no event arrives for
              vibeTerminal.stateIdleFallbackSec (default 300s) → revert to interactive
Bridge unavailable → injected runtime keeps default interactive (text clear)
```

The bridge is SSE, not polling.

## 15.3 Harness Event Mapping

| Harness | Install target | → thinking | → interactive |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` (hooks) | UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart | Stop, PermissionRequest, Notification (permission_prompt / idle_prompt / elicitation_*), SessionEnd |
| Codex | `~/.codex/config.toml` + `~/.codex/hooks.json` | UserPromptSubmit, PreToolUse, PostToolUse | Stop, PermissionRequest, Interrupt, SessionEnd |
| OpenCode | `~/.config/opencode/plugins/vibe-state.ts` | message.part.updated (assistant streaming), tool.execute.before, tool.execute.after, permission.replied | session.idle, permission.asked |
| pi | `~/.pi/agent/hooks/vibe-state.ts` | agent_start, turn_start, tool_call | agent_end, session_shutdown |

Codex notes:

```text
Codex hooks require the experimental feature flag:

  [features]
  codex_hooks = true

Legacy fallback (older Codex, no hooks): the `notify` config key fires only
`agent-turn-complete` → interactive events only; thinking cannot be detected.
Install command must document this limitation.
```

Hook invocation (fast, available on Windows 10+):

```text
curl.exe -m 1 -s -o NUL -X POST http://127.0.0.1:{port}/v1/state \
  -H "Content-Type: application/json" \
  -d "{\"state\":\"thinking\",\"harness\":\"claude\"}"
```

## 15.4 Adapter Install / Uninstall

```text
Vibe Terminal: Install Harness Adapters
    ↓
QuickPick: claude / codex / opencode / pi / all
    ↓
backup original file → write block delimited by markers → done
    ↓
Vibe Terminal: Uninstall Harness Adapters
    ↓
remove marked block → restore backup if file was new
```

Rules:

```text
Every touched file gets a backup before modification
All injected content is delimited by marker comments (idempotent rewrite)
Uninstall restores the original file content
Install is idempotent (re-run does not duplicate blocks)
Never touch files outside the four known harness config locations
```

## 15.5 Fail-Safety

```text
Adapter fires while VS Code is closed     → POST fails, hook exits 0, no effect
Bridge down                                → runtime stays interactive (default)
Injected runtime missing/failed            → no background at all, terminal unaffected
Multiple VS Code windows                   → MVP: share one bridge port (all windows follow)
```

---

# 16. Fast Vibe-Coding UX

The user should not have to edit JSON settings manually.

Primary workflow:

```text
Ctrl+Shift+P
    ↓
Vibe Terminal: Set TikTok Background
    ↓
Paste URL
    ↓
Enter
    ↓
Video starts
```

Target interaction time should be very short.

---

# 17. Cache

Cache TikTok metadata to avoid unnecessary repeated requests.

Suggested location:

```text
Extension global storage
└── cache/
    └── tiktok/
        └── 123456789.json
```

Example:

```json
{
  "id": "123456789",
  "url": "https://www.tiktok.com/@user/video/123456789",
  "width": 720,
  "height": 1280,
  "resolvedAt": 1790000000
}
```

A simple TTL such as 24 hours is acceptable.

Do not cache sensitive user data.

Do not cache authentication credentials.

---

# 18. Persistence

Persist the currently selected background.

Example:

```text
workspace/global state
```

Store:

```text
playlist entries (source type + URL/path per entry, in order)
state visual settings (if overridden from defaults)
audio mode
bridge port
```

Do not store large video binaries in extension state.

For local videos, store the file path.

For TikTok, store the original URL and metadata cache.

---

# 19. Lifecycle

Video/player lifecycle must follow terminal lifecycle.

Desired behavior:

```text
Terminal visible
    ↓
Play

Terminal hidden/inactive
    ↓
Pause if practical

Terminal closed
    ↓
Dispose player

Extension disabled
    ↓
Dispose player

Background cleared
    ↓
Dispose player
```

Avoid continuing to decode video unnecessarily when the terminal is not visible.

---

# 20. Performance Requirements

This is a visual enhancement, not a video application.

Performance priorities:

1. Terminal functionality
2. VS Code stability
3. CPU/GPU efficiency
4. Video quality

Requirements:

- audio follows `vibeTerminal.audio` (default `stateful`); silent fallback whenever unMute is blocked; no audio processing/recording
- harness state updates via SSE — no polling loops
- dedupe/throttle high-frequency harness events (PreToolUse/PostToolUse) server-side
- avoid unnecessary polling in general
- pause when not visible when technically possible
- dispose event listeners
- dispose DOM/player resources
- avoid memory leaks
- avoid spawning unnecessary processes
- do not run FFmpeg in MVP
- do not continuously fetch TikTok metadata

The extension must not noticeably degrade normal vibe-coding performance.

---

# 21. Error Handling

Potential errors:

```text
Invalid TikTok URL
Invalid video ID
TikTok video unavailable
Private/deleted TikTok video
Network failure
TikTok player failure
Unsupported video format
Unsupported VS Code version
Terminal integration failure
```

Behavior:

```text
Show concise error
    ↓
Keep terminal fully functional
    ↓
Do not crash VS Code
```

Example:

```text
Vibe Terminal:
Unable to load TikTok background.
The terminal is still working normally.
```

Do not leave a broken invisible overlay blocking terminal interaction.

---

# 22. Critical Failure Safety

If the background integration fails:

```text
REMOVE BACKGROUND
KEEP TERMINAL
```

Never:

```text
background failure
    ↓
terminal becomes unusable
```

The terminal must always have priority.

---

# 23. Security

Do not execute arbitrary JavaScript from TikTok pages inside the extension host.

Do not evaluate remote JavaScript using `eval`.

Do not trust arbitrary URLs.

Validate input.

For local files:

- validate extension/type
- use appropriate URI handling
- avoid arbitrary shell execution

For TikTok:

- parse known TikTok URL patterns
- use official endpoints/player where possible

---

# 24. Do Not Build These in MVP

Explicitly avoid:

```text
No fake terminal
No custom shell
No full VS Code background
No editor background
No sidebar background
No AI features
No video downloader
No yt-dlp
No FFmpeg
No TikTok scraping
No unofficial TikTok CDN extraction
No database
No remote server (the only listener allowed is the state bridge from §15,
                  bound to 127.0.0.1 inside the extension host — never 0.0.0.0)
No authentication system
No unnecessary backend (no separate daemon process)
```

Keep the extension small.

---

# 25. Phase 1 — Research Before Coding

Before writing the implementation:

1. Inspect the current VS Code extension APIs.
2. Confirm the current limitations around Integrated Terminal DOM access.
3. Determine the least invasive way to render a visual layer behind the existing terminal.
4. Check whether current VS Code versions changed the terminal DOM/workbench structure.
5. Investigate existing open-source terminal-background implementations.
6. Compare their approach with the current VS Code version.
7. Decide on the implementation strategy.

IMPORTANT:

Do not start by assuming that arbitrary Workbench DOM injection is supported.

If a workaround is required, isolate it.

The research phase should produce a short technical decision record:

```text
Approach:
Why:
VS Code versions tested:
Known risks:
Fallback:
```

Only then proceed.

---

# 26. Phase 2 — Extension Skeleton

Create a minimal TypeScript VS Code extension.

Requirements:

- TypeScript
- VS Code Extension API
- minimal dependencies
- clean build
- linting
- basic tests

Add:

```text
extension.ts
commands
configuration
```

Verify the extension activates successfully.

---

# 27. Phase 3 — Local Video

Implement local video support first.

Workflow:

```text
Set Background
    ↓
select local MP4/WebM
    ↓
create video player
    ↓
render behind terminal
    ↓
terminal remains interactive
```

Test:

- play
- loop
- mute
- opacity
- clear
- toggle
- resize

Do not move to TikTok until local video works.

---

# 28. Phase 4 — Terminal Rendering

Implement:

```text
video layer
    ↓
overlay
    ↓
terminal text
```

Verify:

- terminal input works
- terminal scrolling works
- cursor works
- mouse selection works
- ANSI colors work
- interactive CLI apps work
- OpenCode works
- WSL works

Test terminal resizing.

---

# 29. Phase 5 — TikTok

Implement:

1. TikTok URL parser.
2. Video/post ID extraction.
3. oEmbed metadata resolver.
4. Official TikTok Player.
5. Autoplay.
6. Loop.
7. Muted playback.
8. Hidden controls.
9. Error handling.
10. Metadata cache.

Do not implement video downloading in this phase.

---

# 30. Phase 6 — Player Lifecycle

Implement:

```text
play
pause
reload
dispose
```

Connect lifecycle to terminal visibility where possible.

Make sure no event listeners remain after disposal.

---

# 31. Phase 7 — UX

Add:

```text
Set Background
Set TikTok Background
Clear Background
Toggle Background
Reload Background
```

Add Quick Pick / InputBox flows.

Make the workflow fast for vibe coding.

---

# 32. Phase 8 — Testing

## Terminal shells

Test:

```text
PowerShell
CMD
Git Bash
WSL
```

## CLI agents

Test at minimum:

```text
OpenCode
Claude Code
```

If available:

```text
Codex
pi
```

## Terminal layouts

Test:

```text
bottom panel
maximized terminal
terminal resized
terminal hidden
terminal reopened
multiple terminals
switch active terminal
```

## Video aspect ratios

Test:

```text
16:9
9:16
1:1
ultrawide
very tall
```

## TikTok cases

Test:

```text
valid public video
invalid URL
deleted video
private video
network failure
player failure
TikTok iframe blocked by origin (PoC) → blocker reported, not worked around
```

## Harness state adapters

For each harness (OpenCode, Codex, Claude Code, pi):

```text
install adapter → marker block written, backup created
fire each mapped event (§15.3) → bridge receives correct state
uninstall adapter → original file restored byte-for-byte
install twice → still a single block (idempotent)
Codex with hooks disabled → legacy notify fallback documented
```

## State visuals & audio

```text
Simulate Thinking   → text dims, video brightens, smooth fade
Simulate Interactive → text sharp, video dims, smooth fade
idle fallback (stateIdleFallbackSec) reverts thinking → interactive
audio stateful (local video): unMute on thinking, mute on interactive
TikTok iframe: always muted — unMute pauses the embed (§6 Audio)
blocked unMute / audio="muted" → silent, no errors
[ ] requires terminal.integrated.gpuAcceleration="off" (auto-set on activation)
no adapter installed → default state interactive
```

## Playlist

```text
1 entry loops natively
2+ entries rotate on official ended event (onStateChange 0)
wrap-around at end of list
mixed local + TikTok entries
```

## Workbench patch

```text
patch applies → backup created
re-patch is idempotent
Unpatch / Repair restores the original file
VS Code update → re-patch on next activation
corrupt-installation warning behavior documented
patch failure → extension degrades to disabled, terminal stays normal
```

## State bridge

```text
POST /v1/state accepts 127.0.0.1 only
duplicate states dropped (dedupe)
high-frequency events throttled
SSE reconnects after extension host restart
port conflict reported with a clear error
```

## VS Code lifecycle

Test:

```text
extension enable
extension disable
reload window
restart VS Code
terminal restart
```

---

# 33. Acceptance Criteria

The implementation is considered complete only when all applicable items pass.

```text
[ ] Video appears only in Integrated Terminal
[ ] Editor is unaffected
[ ] Existing Integrated Terminal remains the real terminal
[ ] Terminal input works normally
[ ] Terminal scrolling works normally
[ ] ANSI colors work
[ ] Cursor works
[ ] OpenCode works
[ ] WSL works
[ ] PowerShell works
[ ] CMD works
[ ] Git Bash works

[ ] Local MP4 works
[ ] Local WebM works where supported
[ ] Video loops
[ ] Audio follows vibeTerminal.audio for local video (stateful unmute/mute, silent fallback); TikTok iframe stays muted
[ ] GPU acceleration off → DOM renderer → video visible behind terminal
[ ] Video opacity is configurable
[ ] Overlay opacity is configurable
[ ] Text opacity is configurable per state
[ ] Terminal text stays above video
[ ] Video does not capture mouse input
[ ] Terminal resizes video automatically
[ ] 9:16 video does not become distorted
[ ] 16:9 video does not become distorted
[ ] cover mode works
[ ] contain mode works
[ ] fill mode works

[ ] TikTok URL is recognized
[ ] TikTok post ID is extracted
[ ] TikTok metadata can be resolved
[ ] Official TikTok Player is used for MVP
[ ] TikTok autoplay works where allowed
[ ] TikTok loop works
[ ] TikTok muted playback works
[ ] TikTok controls can be hidden
[ ] Invalid TikTok URL is handled
[ ] Unavailable TikTok video is handled

[ ] Background can be toggled
[ ] Background can be cleared
[ ] Background can be reloaded
[ ] Selected background persists
[ ] Metadata is cached
[ ] Player resources are disposed
[ ] No obvious memory leak
[ ] No excessive CPU/GPU usage
[ ] Extension failure never breaks terminal

[ ] Default state is interactive (text readable without any adapter)
[ ] Thinking state dims terminal text while video is clearly visible
[ ] Interactive state keeps text 100% readable over a dimmed video
[ ] State transitions fade smoothly (configurable duration)
[ ] Bridge listens on 127.0.0.1 only
[ ] Idle fallback reverts a stuck thinking state
[ ] Simulate Thinking / Simulate Interactive work without an agent
[ ] Claude Code adapter installs and uninstalls cleanly (backup restored)
[ ] Codex adapter installs and uninstalls cleanly (legacy fallback documented)
[ ] OpenCode adapter installs and uninstalls cleanly
[ ] pi adapter installs and uninstalls cleanly
[ ] Playlist holds at least 1 entry; multi-entry playlists rotate
[ ] Unpatch / Repair restores the original workbench file
[ ] Workbench patch failure never affects the terminal
```

---

# 34. Recommended Implementation Order

Use this exact order:

```text
PHASE 1 — PoC gate + research                                      [DONE]
    ↓
workbench patch proof (injected script runs under workbench CSP)   [PASS]
TikTok iframe-in-workbench proof (postMessage round-trip)          [PASS]
→ write Technical Decision Record (§3)                             [DONE]
    ↓
PHASE 2 — Extension skeleton + settings                            [DONE]
    ↓
PHASE 3 — State bridge (POST /v1/state + SSE) + state machine      [DONE]
    ↓
PHASE 4 — Workbench patcher (backup/patch/restore) + injected runtime with local MP4/WebM  [DONE]
    ↓
PHASE 5 — Terminal rendering/layering + dynamic resize + fit/opacity/overlay  [DONE]
    ↓
PHASE 6 — State-driven visuals (thinking/interactive CSS vars, xterm text opacity, transitions)  [DONE]
    ↓
PHASE 7 — TikTok URL parser + oEmbed metadata + cache/persistence  [DONE]
    ↓
PHASE 8 — TikTok official player + postMessage (mute/unMute, ended events) + playlist rotation  [DONE]
    ↓
PHASE 9 — Audio stateful (unMute/mute per state, silent fallback)  [DONE — integration verified]
    ↓
PHASE 10 — Harness adapters (Claude Code → OpenCode → pi → Codex) + install/uninstall  [DONE — 43/43 tests]
    ↓
PHASE 11 — Lifecycle/performance (pause/dispose, idle fallback, SSE reconnect)  [DONE — integration verified]
    ↓
PHASE 12 — Testing (§32) + packaging                                [DONE — 50/50 tests, .vsix built]
```

Phase 9/11 verification (integration, `poc/run-dev.mjs`, 10/10 PASS):
runtime boots under workbench CSP; host mounted; xterm canvas transparent;
stacking text-above-bg; SSE connects (heal ≤ ~250 ms after bridge listen);
state thinking/interactive apply vis values; TikTok audio round-trip
(thinking→onMute=false, interactive→onMute=true); local MP4 served via
/v1/media; playlist rotates local → TikTok on ended.

Phase 12 result: 50/50 unit tests (11 suites — patch, parser, dimensions,
audio policy, config, state machine incl. throttle, state server incl.
localhost binding/port conflict/SSE/media allow-list, oembed, cache,
adapter builders + install), typecheck + eslint clean, `npm run package`
produces `vibe-terminal-background-0.1.0.vsix` (dist only, `.vscodeignore`).
Remaining QA is the manual §33 acceptance checklist (shell variants,
WSL, reload/disable/enable lifecycle, memory observation).

Do not implement all features at once.

After every major phase, verify the previous functionality still works.

---

# 35. Future Phase — Local TikTok Media

Only investigate this if the official TikTok Player is visually unsuitable for a terminal background.

Possible future architecture:

```text
TikTok URL
    ↓
media resolver
    ↓
local cached media
    ↓
HTML <video>
    ↓
terminal background
```

Only introduce this after MVP evaluation.

Potential dependencies such as yt-dlp or FFmpeg must be justified first.

Do not add them just because they appear convenient.

---

# 36. Future Features

Possible later features:

```text
playback speed
blur
brightness
saturation
background presets
random video selection
time-based video switching
pause while terminal is inactive
keyboard shortcut
per-workspace background
per-terminal background
animated image support
remote MP4 URL
YouTube support via a PlaylistSource implementation (interface introduced in MVP)
generic output-activity adapter for harnesses without native hooks (heuristic: streaming → thinking, silence → interactive)
extra states (e.g. permission) beyond thinking/interactive
```

Do not implement these unless MVP is stable.

---

# 37. Final Technical Principle

The extension should remain:

```text
SMALL
LOCAL
FAST
TERMINAL-ONLY
LOW-OVERHEAD
```

The ideal architecture is:

```text
                   VIBE TERMINAL
                        │
        ┌───────────────┴───────────────┐
        │                               │
   Video Source                    Terminal
        │                               │
   ┌────┴────┐                     xterm.js
   │         │                         │
 Local    TikTok                       │
   │         │                         │
 MP4/WebM  Official Player              │
   │         │                         │
   └────┬────┘                         │
        │                               │
        └──────────┬────────────────────┘
                   ↓
             Background Layer
                   ↓
             Overlay Layer
                   ↓
             Terminal Text
```

The extension must never compromise the terminal itself.

---

# 38. Developer Instruction for OpenCode

When implementing this specification:

1. First inspect the repository and current VS Code extension APIs.
2. Do not assume unsupported APIs exist.
3. Research the current Integrated Terminal rendering architecture.
4. Research existing open-source implementations if necessary.
5. State the chosen terminal injection/rendering strategy before coding.
6. Implement incrementally.
7. Keep the extension minimal.
8. Avoid unnecessary dependencies.
9. Never replace the real terminal with a fake terminal.
10. Never break terminal input/output.
11. Never modify the Editor background.
12. Do not add TikTok download functionality in MVP.
13. Prefer official TikTok APIs/player.
14. Test after every major phase.
15. If a technical blocker is discovered, stop and explain the blocker instead of implementing a fragile workaround silently.
16. Complete the Phase 1 PoC gate (workbench patch + TikTok iframe round-trip) before building features; record the Technical Decision Record from §3.
17. Harness adapters must back up every file they modify and restore it exactly on uninstall; never touch config outside the four known harness locations.
18. State changes are visual only: never let bridge/adapter/patch failures block terminal input, output, or focus — default to the interactive state instead.

Final priority:

```text
Terminal functionality
    >
VS Code stability
    >
Performance
    >
Video effect
```
