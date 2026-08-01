import { isCtrlCmdSwapActive, modifiersNeedSwap } from '../../../shared/modifier-remap'
import { getShortcutPlatform } from './shortcut-platform'

/**
 * Renderer half of the Ctrl/Cmd remap: rewrites the modifier flags on every key event
 * during the window capture phase, before any consumer sees it.
 *
 * Window capture runs ahead of xterm's own capture listeners on the terminal textarea,
 * so the same mutated event drives both Orca's keybinding matcher and xterm's encoder —
 * a swapped Cmd+C reaches the PTY as a real ^C.
 *
 * Everything downstream — matching, recording, conflict detection — therefore lives in
 * post-swap coordinates. Only the glyph layer inverts back (see formatKeybinding).
 */

const REMAPPED_EVENTS = ['keydown', 'keyup', 'keypress'] as const

let enabled = false

/** Toggled from settings; the listener installs once at bootstrap, before settings load. */
export function setCtrlCmdSwapEnabled(value: boolean): void {
  enabled = value
}

export function syncCtrlCmdSwapFromSettings(modifierRemap: unknown): void {
  setCtrlCmdSwapEnabled(isCtrlCmdSwapActive(modifierRemap, getShortcutPlatform()))
}

export function isCtrlCmdSwapEnabled(): boolean {
  return enabled
}

function overrideModifier(event: KeyboardEvent, property: string, value: boolean): void {
  // defineProperty shadows the prototype getter; plain assignment is a silent no-op on DOM events.
  Object.defineProperty(event, property, { value, configurable: true, enumerable: true })
}

function swapEventModifiers(event: KeyboardEvent): void {
  if (!enabled) {
    return
  }
  const modifiers = { control: event.ctrlKey, meta: event.metaKey }
  if (!modifiersNeedSwap(modifiers)) {
    return
  }
  overrideModifier(event, 'ctrlKey', modifiers.meta)
  overrideModifier(event, 'metaKey', modifiers.control)
}

export function installCtrlCmdSwap(target: Window = window): () => void {
  for (const type of REMAPPED_EVENTS) {
    target.addEventListener(type, swapEventModifiers as EventListener, { capture: true })
  }
  return () => {
    for (const type of REMAPPED_EVENTS) {
      target.removeEventListener(type, swapEventModifiers as EventListener, { capture: true })
    }
  }
}
