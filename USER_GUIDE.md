# USER GUIDE — Vibe Terminal Background

This guide is for **end users** of the extension (install and daily use).
Technical details: `README.md`. Automated testing workflow: `HUONG_DAN.md`.

The extension puts a **looping video background behind the VS Code Integrated
Terminal** (local MP4/WebM or TikTok) and switches visuals / gates audio by the
AI agent's state:

- **`thinking`** — the agent is reasoning / calling tools / streaming output →
  video **bright**, audio on.
- **`interactive`** — the agent asks you something or finished → video **dim**,
  terminal text 100% readable, audio off.

The agent only needs a one-line `curl` hook that reports its state to the local
bridge on `127.0.0.1` — the agent itself is never modified.

---

## 1. Requirements

| Thing | Note |
|---|---|
| **Windows** | The current release is verified on Windows (curl, paths and the workbench patch are Windows-oriented). |
| VS Code ≥ 1.95 | Verified on **1.141**. |
| `gpuAcceleration: "off"` | **Required** — the extension sets it on activation. The WebGL canvas would cover the video. |
| MP4/WebM video or TikTok URL | TikTok needs network; local files do not. |
| Git Bash (for Claude Code) | Claude's hook runs through a shell — see §6.2. |

---

## 2. Install (once)

```powershell
code --install-extension E:\Terminal_extension\vibe-terminal-background-0.1.0.vsix
```

Then **Reload Window**: `Ctrl+Shift+P` → `Developer: Reload Window`.

**Verify it is running:**

1. `Ctrl+Shift+P` → type `Vibe Terminal:` → the command list appears.
2. Open the **Vibe Terminal** output channel → you should see
   `state bridge listening on 127.0.0.1:<port>` (default `47832`; if taken, the
   extension takes `47833`, `47834`… up to +28).
3. If VS Code asks to set `gpuAcceleration: "off"` → **accept**, then reload /
   reopen the terminal.

---

## 3. Set a video background

| Task | How |
|---|---|
| Local video | `Vibe Terminal: Set Background` → pick an `.mp4`/`.webm` file |
| TikTok | `Vibe Terminal: Set TikTok Background` → paste a TikTok URL |
| Multi-video playlist | `Add TikTok to Playlist` to append; with ≥2 entries videos rotate when one ends |
| Inspect playlist | `Show Playlist` (▶ = currently playing; remove/copy/settings actions) |
| Pause / remove | `Toggle Background` / `Clear Background` |
| Start over | `Reload Background` |

After setting it → open the integrated terminal `` Ctrl+` `` → the video runs
behind the text.

---

## 4. Transparency keybindings

The two videos (**thinking** and **interactive**) are **two independent values** —
each state owns its own key pair, and you can tune **either one at any time**,
regardless of which state is currently active:

| Key | Action |
|---|---|
| `Ctrl+Alt+Shift+↑` | Thinking video **clearer** (+0.05) |
| `Ctrl+Alt+Shift+↓` | Thinking video **fainter** (−0.05) |
| `Ctrl+Alt+Shift+→` | Interactive video **clearer** (+0.05) |
| `Ctrl+Alt+Shift+←` | Interactive video **fainter** (−0.05) |

- Values are clamped to `0.00 – 1.00`, step `0.05`.
- At a limit you get: `... video opacity at 0.00 limit`.
- The status bar shows the new value, e.g. `thinking video opacity 0.85 → 0.90`.
- The value is **saved to settings** (workspace scope when a folder is open) →
  it survives reloads.
- Prefer the palette? The four commands are also there:
  `Thinking Video: Increase/Decrease Opacity`,
  `Interactive Video: Increase/Decrease Opacity`.

To edit all three layers (video / overlay / text) and every setting in one place:

```
Ctrl+Shift+P → Vibe Terminal: Open Settings (JSON)
```

→ pick **Global** (user settings.json — default for every folder) or
**Workspace** (`.vscode/settings.json` — this folder only). In the JSON type
`vibeTerminal.` + `Ctrl+Space` for IntelliSense over every setting.

---

## 5. Common settings

`Ctrl+,` → search `vibeTerminal`:

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `playlist` | `[]` | Video list (local + TikTok can be mixed) |
| `fit` | `cover` | `cover` / `contain` / `fill` |
| `audio` | `stateful` | `stateful` = sound only while thinking; `muted` = silent; `unmuted` = always audible (best-effort) |
| `transitionMs` | `350` | Fade duration between the two states |
| `states.thinking/interactive` | see §4 | Opacities of 3 layers: `videoOpacity` / `overlayOpacity` / `textOpacity` |
| `notifyOnDone` | `true` on Windows | Audio alert when the agent finishes (gentle volume fade-in of VS Code) |
| `notifySec` | `30` | Alert duration in seconds (1–300) |
| `idleFreezeSec` | `30` | Pause the video after N idle seconds (0 = off) |
| `stateIdleFallbackSec` | `300` | Agent silent for N seconds → fall back to `interactive` |
| `bridgePort` | `47832` | Local bridge port (1024–65535) |

Example `settings.json`:

```json
{
  "vibeTerminal.playlist": ["E:/Videos/my-clip.mp4"],
  "vibeTerminal.audio": "stateful",
  "vibeTerminal.states.thinking":    { "videoOpacity": 0.85, "overlayOpacity": 0.10, "textOpacity": 0.40 },
  "vibeTerminal.states.interactive": { "videoOpacity": 0.15, "overlayOpacity": 0.55, "textOpacity": 1.00 },
  "vibeTerminal.notifyOnDone": true
}
```

**Audio note:** the TikTok iframe is **always muted** by the browser's policy
(unmuting outside a user gesture makes the embed pause itself). For sound, use a
**local MP4/WebM**.

---

## 6. Connect your agent (opencode / claude / codex / pi)

### 6.1 Install the adapter

```
Ctrl+Shift+P → Vibe Terminal: Install Harness Adapters
```

Pick a harness or `all`. Files written (marker + backup, cleanly uninstallable):

| Agent | File |
|---|---|
| OpenCode | `~/.config/opencode/plugins/vibe-state.ts` |
| Claude Code | `~/.claude/settings.json` (merged, your content preserved) |
| Codex | `~/.codex/hooks.json` + `~/.codex/config.toml` |
| pi | `~/.pi/agent/hooks/vibe-state.ts` |

### 6.2 ⚠️ Required after installing (do not skip)

1. **Restart the agent** — all four agents read hooks/plugins only at startup.
   Installing mid-session requires quitting and re-running the agent.
2. **Codex specifically:** Codex **does not run hooks until you trust them**.
   Run `/hooks` inside Codex → find the `vibe-terminal` hook → trust/approve it.
   Skip this and the state never changes — with no error shown.
3. **Claude Code on Windows:** hooks run through a shell. With **Git Bash**
   installed they work; without it Claude falls back to PowerShell 5.1 and the
   `curl` line can break **silently**. **Install Git Bash** if the state never
   changes.
4. **pi:** the adapter writes to `~/.pi/agent/hooks/` — pi ≥ 0.35 shows a
   deprecation warning (still works) and may move to `extensions/` in a future
   release. If the state never changes, check pi's startup log for warnings.

### 6.3 Verify it works

1. Run the agent in the terminal → give it a heavy task (write code, call tools).
2. Expected: while working → video **bright** (thinking); when it asks permission
   / finishes → video **dim** (interactive).
3. The **Vibe Terminal** output shows `state -> thinking (real-event, <harness>)`.

Uninstall: `Vibe Terminal: Uninstall Harness Adapters` (backups restored
byte-for-byte).

---

## 7. Multiple VS Code windows

- Each window takes **its own bridge port** (scanned upward from `bridgePort`),
  shown in the status bar.
- `playlist` / `enabled` are stored **per folder** (`.vscode/settings.json`) →
  two different folders never overwrite each other.
- **Note:** the adapter is written with the **port of the window where you ran
  Install**. Install it in the window that owns the agent; if you change
  `bridgePort` after installing → uninstall and install again.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| No video | Playlist needs ≥1 entry; reload after the patch; `gpuAcceleration` must be `"off"` |
| No sound | You are in interactive (correct behavior); TikTok is always muted — use a local video; check `audio` |
| Agent state never changes | ① Did you **restart the agent**? ② Output shows `state -> ... (real-event)`? ③ Codex: trusted via `/hooks`? ④ Claude: Git Bash installed? ⑤ Re-run Install and check the file contains the `vibe-terminal` marker |
| Opacity keys do nothing | Reload Window after installing; check for key conflicts in `Keyboard Shortcuts` (search `Vibe Terminal`) |
| Port 47832 busy | Nothing to do — the extension takes the next port; or change `vibeTerminal.bridgePort` |
| Video gone after a VS Code update | Reopen VS Code — it re-patches automatically; use `Unpatch / Repair` to stop for good |
| Detailed logs | **Vibe Terminal** output channel |

---

## 9. Full uninstall (restore stock VS Code)

Run these three commands in order, then uninstall the extension:

```
1. Vibe Terminal: Uninstall Harness Adapters   (restores agent files)
2. Vibe Terminal: Clear Background             (clears the playlist setting)
3. Vibe Terminal: Unpatch / Repair             (restores the original workbench.html)
```

```powershell
code --install-extension --uninstall vibe-terminal-background
```

Verify clean: `workbench.html` no longer contains `vibe-terminal`
(the `.vibe-terminal.bak` backup sits next to the original — safe to delete).

---

## 10. Quick reference — every command

| Command | What it does |
|---|---|
| `Set Background` / `Set TikTok Background` | Set the background video |
| `Add TikTok to Playlist` / `Remove from Playlist` / `Show Playlist` | Manage the playlist |
| `Toggle Background` / `Clear Background` / `Reload Background` | On/off/clear/restart |
| `Install / Uninstall Harness Adapters` | Agent hooks |
| `Simulate Thinking` / `Simulate Interactive` | Preview states without an agent |
| `Open Settings (JSON)` | Open settings JSON (Global/Workspace) |
| `Thinking Video: Increase/Decrease Opacity` | Keys `Ctrl+Alt+Shift+↑/↓` |
| `Interactive Video: Increase/Decrease Opacity` | Keys `Ctrl+Alt+Shift+←/→` |
| `Unpatch / Repair` | Restore the original VS Code file |
