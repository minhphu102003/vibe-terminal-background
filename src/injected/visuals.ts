// State → CSS variable application + the injected stylesheet (spec §11, §12).

import type { RuntimeConfig, VibeState } from '../config/settings';

export const STYLE_ID = 'vibe-terminal-style';
export const ROOT_CLASS = 'vibe-bg-root';
export const HOST_CLASS = 'vibe-host';

const CSS = `
.${ROOT_CLASS} {
  position: absolute;
  inset: 0;
  overflow: hidden;
  z-index: 0;
  pointer-events: none;
  background: transparent;
}
.${ROOT_CLASS} .vibe-media {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: var(--vibe-fit, cover);
  opacity: var(--vibe-video-opacity, 0.15);
  transition: opacity var(--vibe-transition, 350ms) ease-in-out;
  pointer-events: none;
  border: 0;
  display: block;
  background-color: #000;
}
.${ROOT_CLASS} .vibe-media--iframe {
  object-fit: fill;
  background: transparent;
}
.${ROOT_CLASS} .vibe-overlay {
  position: absolute;
  inset: 0;
  background: #000;
  opacity: var(--vibe-overlay-opacity, 0.55);
  transition: opacity var(--vibe-transition, 350ms) ease-in-out;
  pointer-events: none;
}
.${HOST_CLASS},
.${HOST_CLASS} .terminal-groups-container,
.${HOST_CLASS} .terminal-group,
.${HOST_CLASS} .instance-container,
.${HOST_CLASS} .terminal-sash-container,
.${HOST_CLASS} .terminal-sash,
.${HOST_CLASS} .terminal-wrapper,
.${HOST_CLASS} .terminal-outer-container,
.${HOST_CLASS} .xterm,
.${HOST_CLASS} .xterm-viewport,
.${HOST_CLASS} .xterm-scrollable-element,
.${HOST_CLASS} .xterm-screen,
.${HOST_CLASS} .xterm-rows {
  background-color: transparent !important;
}
.${HOST_CLASS} .xterm {
  opacity: var(--vibe-text-opacity, 1);
  transition: opacity var(--vibe-transition, 350ms) ease-in-out;
}
.${HOST_CLASS} .xterm-rows span[class*="xterm-bg-"]:not([class*="xterm-cursor"]),
.${HOST_CLASS} .xterm-rows span[style*="background-color"]:not([class*="xterm-cursor"]) {
  background-color: transparent !important;
}
`.replace(/^\s+/gm, '');

export function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

export function applyConfigVars(root: HTMLElement, cfg: RuntimeConfig): void {
  root.style.setProperty('--vibe-fit', cfg.fit);
  root.style.setProperty('--vibe-transition', `${cfg.transitionMs}ms`);
}

export function applyStateVars(root: HTMLElement, cfg: RuntimeConfig, state: VibeState): void {
  const v = cfg.states[state];
  root.style.setProperty('--vibe-video-opacity', String(v.videoOpacity));
  root.style.setProperty('--vibe-overlay-opacity', String(v.overlayOpacity));
  root.style.setProperty('--vibe-text-opacity', String(v.textOpacity));
}

export function setHostState(host: HTMLElement, state: VibeState): void {
  host.setAttribute('data-vibe-state', state);
}
