# Kiến trúc & Thuật ngữ bản chất — Vibe Terminal Background

> Tài liệu này giải thích **bản chất** của extension: mỗi thành phần thực sự làm gì ở
> tầng thấp (Electron/Chromium), và tại sao các quyết định tối ưu được đưa ra.
> Mục tiêu: để bạn hiểu tôi đang "đào" chỗ nào khi nói về tối ưu tài nguyên.

---

## 1. Extension này làm gì (1 câu)

Đặt một **video TikTok (hoặc file local) làm nền sau chữ terminal** trong VS Code,
và **đổi độ mờ / trạng thái** video theo "tâm trạng" của AI (thinking / interactive).

---

## 2. Kiến trúc tổng thể — 4 tầng

```
┌─────────────────────────────────────────────────────────────┐
│ TẦNG 4 — Harness adapters (opencode / claude / codex / pi)  │
│   Gửi event "AI đang nghĩ / đang rảnh" → bridge             │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP POST /v1/state
┌──────────────────────────▼──────────────────────────────────┐
│ TẦNG 3 — Extension host (Node.js, process riêng/cửa sổ)     │
│   • StateServer  : HTTP 127.0.0.1:<port> + SSE /v1/events   │
│   • StateMachine : dedupe, throttle, idle-fallback           │
│   • WorkbenchPatcher : vá file workbench.html trên đĩa      │
│   • Settings     : đọc/ghi vibeTerminal.* (Workspace scope)  │
└──────────────────────────┬──────────────────────────────────┘
                           │ SSE (nhận config + state) + HTTP (media)
┌──────────────────────────▼──────────────────────────────────┐
│ TẦNG 2 — Injected Runtime (JS chạy trong workbench renderer)│
│   • VibeRuntime  : mount <video>/<iframe>, IntersectionObs, │
│                    visibilitychange, polling loops           │
│   • PlayerManager: điều khiển play/pause/mute, xoay playlist │
│   • visuals.ts   : CSS variables + stylesheet nền            │
└──────────────────────────┬──────────────────────────────────┘
                           │ DOM + CSS (opacity)
┌──────────────────────────▼──────────────────────────────────┐
│ TẦNG 1 — Chromium compositor (GPU process)                  │
│   Ghép lớp video + lớp overlay + chữ terminal thành khung  │
└─────────────────────────────────────────────────────────────┘
```

**Điểm mấu chốt**: extension **không** render video bằng code của chính nó.
Nó chỉ (a) chèn một thẻ `<iframe>` TikTok hoặc `<video>` vào DOM, và (b) đổi
`opacity` bằng CSS. Việc decode + ghép hình do **Chromium/GPU** đảm nhiệm.

---

## 3. Thuật ngữ bản chất (Glossary)

### 3.1 Các loại Process trong Electron/VS Code

| Thuật ngữ | Bản chất | Chi phí |
|---|---|---|
| **Main process** | Process "cha" điều phối, có API OS. Một cho mỗi instance VS Code. | nhẹ |
| **Renderer process** | Một process Chromium "vẽ" một cửa sổ (window). Chạy DOM/JS/CSS. Mỗi cửa sổ ≈ 1 renderer. | **nặng** (100–900 MB) |
| **Extension host** | Process Node.js riêng chạy code extension, tách khỏi renderer (bảo mật). Một mỗi cửa sổ. | trung bình |
| **GPU process** | Process duy nhất lo **compositing**: ghép các lớp (video, overlay, chữ) thành khung hình cuối, gửi ra màn hình. | trung bình–nặng |
| **OOPIF** (Out-of-Process Iframe) | Chromium có thể tách một `<iframe>` **cross-origin** thành **process riêng** (Site Isolation trên desktop). Nếu TikTok iframe thành OOPIF → thêm 1 process ~150MB. | có thể nặng |

> **Bản chất video TikTok**: iframe `https://www.tiktok.com` nhúng trong
> `vscode-file://` workbench là **cross-origin**. Trên desktop Chromium bật
> Site Isolation, iframe này **có thể** chạy trong process riêng (OOPIF).
> Khi terminal scrolled-out-of-view, Chromium **tự** dừng rAF/paint cho
> iframe cross-origin (Render Throttling) — nhưng **không tự dừng decode video**.

### 3.2 Các khái niệm sự kiện / hiển thị

| Thuật ngữ | Bản chất | Liên quan tối ưu |
|---|---|---|
| **`document.hidden`** | `true` khi cửa sổ **không hiển thị** (thu nhỏ / bị che khuất hoàn toàn). Đổi qua sự kiện `visibilitychange`. | Gốc của việc pause video khi chuyển app. |
| **`IntersectionObserver`** | API báo khi một element **ra/vào viewport**. Extension dùng để pause khi terminal bị scroll-away hoặc đóng panel. | Đã có từ đầu. |
| **Render Throttling** | Chromium **tự dừng** rAF/style/layout/paint cho iframe **cross-origin** khi nó ra ngoài viewport. Same-origin thì **không** bị. | Tiết kiệm free khi scroll-away, nhưng **không** dừng decode. |
| **Intensive Wake-Up Throttling** | Trang/iframe ẩn >10s → Chromium giới hạn còn **1% CPU**, 1 lần/rút. | Chromium tự tiết kiệm 1 phần khi ẩn. |
| **rAF** (requestAnimationFrame) | Callback đồng bộ với refresh rate màn hình, dùng cho animation. Khi hidden → **rAF ngừng hẳn**. | Animation ngừng khi ẩn, nhưng video decode thì không. |

### 3.3 Bridge & Realtime

| Thuật ngữ | Bản chất |
|---|---|
| **StateServer (Bridge)** | HTTP server Node.js绑 trên `127.0.0.1:<port>`. Cửa sổ nào cũng mở 1 cái. Port base 47832, scan thêm nếu bị chiếm (multi-instance). |
| **SSE** (Server-Sent Events) | Kênh 1 chiều server→runtime, tự nối lại. Dùng để push config + state mới nhất xuống injected runtime. Khác WebSocket (2 chiều) ở chỗ đơn giản hơn, đủ dùng. |
| **StateMachine** | Chuyển state (thinking/interactive) có: **dedupe** (bỏ trùng), **throttle** (hạn chế tần suất), **idle-fallback** (thinking quá lâu → tự về interactive). |

### 3.4 Workbench Patch (cơ chế "hack")

| Thuật ngữ | Bản chất |
|---|---|
| **workbench.html** | File HTML chính VS Code load khi mở cửa sổ. **Chung cho mọi cửa sổ** (cùng 1 file trên đĩa). |
| **WorkbenchPatcher** | Tại activation, extension **vá** file này: chèn 1 script `<script>` chứa bundled runtime + mở rộng CSP cho phép load `127.0.0.1:<port>` và TikTok. **Idempotent** (patch lại thay block cũ). |
| **CSP** (Content Security Policy) | Chính sách bảo mật chặn load resource ngoài. Phải mở rộng để iframe TikTok + media bridge được phép. |
| **Tại sao cần StatusBarItem discover** | Vì workbench.html **chung** mọi cửa sổ, port nhúng trong đó không đáng tin. Mỗi cửa sổ ghi `vibe-bridge:<port>` thật vào thanh status; runtime đọc DOM đó để biết port của **chính nó**. |

---

## 4. Luồng dữ liệu (1 vòng)

```
1. opencode/claude chạy → hook gửi POST /v1/state {state:"thinking"}
2. StateMachine dedupe/throttle → phát SSE "state" xuống mọi runtime
3. Runtime nhận → applyStateVars() đổi CSS var --vibe-video-opacity
4. CSS transition 350ms ease-in-out → video mờ dần, chữ hiện rõ
5. GPU process ghép lớp mới mỗi frame → màn hình
6. Runtime POST /v1/player (vị trí playlist) để command Show Playlist biết
```

---

## 5. Bản chất chi phí tài nguyên (Tại sao tốn CPU?)

Video nền **không miễn phí**. Chi phí thực sự nằm ở 3 chỗ:

### 5.1 Decode video (CPU/GPU)
TikTok iframe tự decode video bên trong (hoặc trong OOPIF). Decoder chạy
**liên tục 30–60fps** dù bạn có nhìn hay không, **trừ khi ta pause chủ động**.

### 5.2 Compositing (GPU process)
Mỗi frame, GPU process phải:
- Lấy khung video từ decoder
- Ghép với lớp overlay (đen mờ) + lớp chữ terminal
- Đẩy ra màn hình

Đổi `opacity` (khi chuyển state) buộc ghép lại → spike短暂.

### 5.3 Bộ nhớ (RAM)
- iframe TikTok = **một browsing context** (có thể là process riêng ~150MB)
- GPU process giữ buffer khung hình
- Extension host + injected runtime + cache metadata

### 5.4 Điều extension **không** kiểm soát được
- Decoder + compositor là của Chromium — extension chỉ toggle `play/pause` + `opacity`.
- Không giảm được fps decode của TikTok (player là hộp đen cross-origin).
- OOPIF hay in-process do Chromium quyết định.

### 5.5 Điều extension **kiểm soát được** (đây là chỗ tối ưu)
- **KHI NÀO** video chạy: pause khi ẩn (`visibilitychange`) + khi terminal ẩn (`IntersectionObserver`) — **đã làm** (fix #1 + #2).
- **Bao nhiêu lớp** phải ghép: số lớp CSS, transition có cần không.
- **Tần suất polling**: các `setInterval` trong runtime (log 300ms, scan 5s, sseGuard 1s).

---

## 6. Các triết lý tối ưu (Philosophy)

### Triết lý A — "Đừng decode khi không ai xem" (ĐÃ LÀM)
Video chỉ cần chạy khi **cả 2** điều kiện: (window visible) VÀ (terminal on-screen).
- `visibilitychange` → pause khi `document.hidden`
- `IntersectionObserver` → pause khi terminal scroll-away
- Combine qua `syncPlayback()`.
- **Bản chất**: dừng decoder + compositor → tiết kiệm ~2 nhân CPU khi ẩn.

### Triết lý B — "Chromium đã free sẵn, đừng double-pay"
Chromium **tự** render-throttle iframe cross-origin khi ra viewport, và intensive-throttle khi ẩn >10s. Nghĩa là:
- Khi ẩn: Chromium đã giảm rAF/timer → ta chỉ cần thêm **pause decode** (việc Chromium không làm).
- **Đừng** phụ thuộc hoàn toàn vào Chromium throttle (nó không dừng decode), nhưng cũng **đừng** lo nó làm thừa — nó free.

### Triết lý C — "Lớp càng ít, ghép càng nhanh" (CHƯA KHAI THÁC)
Mỗi lớp opacity mờ + overlay = 1 lớp phải ghép. Có thể:
- Bỏ overlay layer, dùng `background` tối trực tiếp trên video (gộp 2 lớp → 1).
- Dùng `mix-blend-mode` thay vì overlay riêng.
- Thêm `will-change: opacity` để compositor chuẩn bị layer riêng (tách lớp, giảm re-composite).

### Triết lý D — "Idle = tĩnh" (✅ ĐÃ LÀM — `vibeTerminal.idleFreezeSec`, mặc định 30s)
Khi state `interactive` và **không có gì thay đổi** trong `idleFreezeSec` giây, video
tự **pause** → decoder dừng (0 CPU decode) trong khi khung đóng băng (interactive
videoOpacity ≈ 0.15, hầu như vô hình) vẫn hiện. Resume ngay khi có state change.
- **Bản chất**: biến "video nền" thành "ảnh đóng băng lúc idle, chuyển động khi
  có hoạt động" → gần như **0 CPU decode** lúc idle.
- Ghi đè Triết lý A: pause khi idle được combine vào chung `syncPlayback()`
  (chỉ play khi `hostVisible && docVisible && !idleFrozen`).
- Không cần poster/thumbnail:暂停 giữ khung cuối, và ở interactive opacity đã mờ 0.15.
- **Vì sao giữ iframe TikTok vẫn tối ưu được D**: postMessage `pause` dừng decode
  ngay cả với player hộp đen; ta không cần control nội dung, chỉ cần bật/tắt phát.

### Triết lý E — "Runtime ngủ khi rảnh" (CHƯA KHAI THÁC)
Các `setInterval` trong runtime chạy hoài:
- `flushLogs` 300ms — có thể chuyển sang chỉ flush khi **có** log (event-driven).
- `sseGuard` 1s — kiểm tra SSE có sống; có thể giãn khi SSE ổn định.
- `scan` 5s — cần cho remount, nhưng có thể dừng khi đã mount ổn định.
- **Bản chất**: giảm timer wake-up → CPU idle thấp hơn, hợp Intensive Throttling philosophy của Chromium.

---

## 7. Bảng mapping "Code → Bản chất"

| File | Vai trò ở tầng | Ghi chú tối ưu |
|---|---|---|
| `src/extension.ts` | Tầng 3 (extension host) | Port scan, status bar, patch, commands |
| `src/bridge/stateServer.ts` | Tầng 3 | HTTP + SSE bridge |
| `src/bridge/stateMachine.ts` | Tầng 3 | dedupe/throttle/idle-fallback |
| `src/patch/manifest.ts` | Tầng 3 | CSP range, marker block |
| `src/injected/runtime.ts` | Tầng 2 | **IntersectionObs + visibilitychange + polling** |
| `src/injected/player.ts` | Tầng 2 | **play/pause iframe + video** |
| `src/injected/visuals.ts` | Tầng 2 | CSS layers + transitions |
| (Chromium) | Tầng 1 | decode + compositing (ngoài tầm kiểm soát trực tiếp) |

---

## 8. Kết luận: extension tối ưu được tới đâu?

- **Đã tối ưu** (triết lý A): pause khi ẩn (`visibilitychange` + `IntersectionObserver`) → cắt ~2 nhân CPU khi chuyển app / terminal scroll-away.
- **Đã tối ưu** (triết lý D): idle-freeze (`idleFreezeSec`, mặc định 30s) → pause khi interactive idle → **0 CPU decode** lúc rảnh.
- **Bỏ qua** (C, E): gộp lớp CSS / ngủ timer — chỉ vài % hoặc vài micro-giây, không đáng đổi complexity.
- **Không thể**: giảm fps decode của TikTok, kiểm soát OOPIF, chặn Chromium compositing.

Tối ưu triệt để nhất = **Triết lý D** (idle → ảnh tĩnh), đổi lại là video
không luôn luôn nhấp nháy. Cân nhắc theoguồn cảm hứng của extension này.
