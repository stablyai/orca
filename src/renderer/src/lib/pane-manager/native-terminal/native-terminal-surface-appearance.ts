import type { Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { NativeTerminalAppearance } from '../../../../../shared/native-terminal-appearance'
import { getUIZoomFactorForNativeViews } from '../../ui-zoom'
import { buildNativeTerminalAppearance } from './native-terminal-appearance'
import { scheduleNativeTerminalFrames } from './native-terminal-frames'

// Ghostty's app config only holds defaults; each surface runs its own config so a pane's
// font zoom reaches its native view.
export type NativeSurfaceAppearanceState = {
  surfaceId: number | null
  disposed: boolean
  // This pane's font size (per-pane zoom) and the surface config last sent for it.
  fontSize: number | null
  appearanceKey: string | null
}

// A pane and the font size its xterm uses (the pane's zoom, else the global setting).
export type NativeTerminalPaneFont = { terminal: Terminal; fontSize: number }

let lastSettings: GlobalSettings | null | undefined = null
const statesByTerminal = new WeakMap<Terminal, NativeSurfaceAppearanceState>()

export function trackNativeSurfaceAppearance(
  terminal: Terminal,
  state: NativeSurfaceAppearanceState
): void {
  statesByTerminal.set(terminal, state)
}

export function rememberNativeTerminalSettings(settings: GlobalSettings | null | undefined): void {
  lastSettings = settings
}

export function surfaceAppearanceKey(
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): string {
  return JSON.stringify([appearance, zoomFactor])
}

// A new surface already runs the appearance main created it with as its own config.
export function rememberCreatedSurfaceAppearance(
  state: NativeSurfaceAppearanceState,
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): void {
  state.fontSize = appearance.fontSize
  state.appearanceKey = surfaceAppearanceKey(appearance, zoomFactor)
}

export function sendSurfaceAppearance(
  terminal: Terminal,
  state: NativeSurfaceAppearanceState,
  fontSize: number
): void {
  const api = typeof window === 'undefined' ? null : (window.api?.nativeTerminal ?? null)
  if (!api || state.surfaceId === null || state.disposed) {
    return
  }
  const appearance = { ...buildNativeTerminalAppearance(terminal.options, lastSettings), fontSize }
  const zoomFactor = getUIZoomFactorForNativeViews()
  const key = surfaceAppearanceKey(appearance, zoomFactor)
  state.fontSize = fontSize
  if (key === state.appearanceKey) {
    return
  }
  state.appearanceKey = key
  api.setSurfaceAppearance(state.surfaceId, appearance, zoomFactor)
  scheduleNativeTerminalFrames()
}

// Per-pane font zoom writes xterm's fontSize directly, outside applyTerminalAppearance.
export function setNativeTerminalFontSize(terminal: Terminal, fontSize: number): void {
  const state = statesByTerminal.get(terminal)
  if (state) {
    sendSurfaceAppearance(terminal, state, fontSize)
  }
}
