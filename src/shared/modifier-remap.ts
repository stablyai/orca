/**
 * iTerm-style global Ctrl/Cmd remap.
 *
 * The swap is applied once, to the key event itself, at each boundary where input
 * enters Orca (main's before-input-event, and each renderer's window capture phase).
 * Everything downstream — the keybinding matcher, xterm's encoder, Monaco — reads the
 * already-swapped flags and needs no knowledge of this setting.
 */

export type ModifierRemap = 'none' | 'swap-ctrl-cmd'

/** Modifier pair shared by Electron's `before-input-event` input and our DOM adapter. */
export type SwappableModifiers = {
  control: boolean
  meta: boolean
}

export function normalizeModifierRemap(value: unknown): ModifierRemap {
  return value === 'swap-ctrl-cmd' ? 'swap-ctrl-cmd' : 'none'
}

// Why: Linux/Windows already put app chords on Ctrl; swapping there inverts a working layout.
export function isCtrlCmdSwapActive(value: unknown, platform: NodeJS.Platform): boolean {
  return normalizeModifierRemap(value) === 'swap-ctrl-cmd' && platform === 'darwin'
}

export function swapCtrlCmd(modifiers: SwappableModifiers): SwappableModifiers {
  return { control: modifiers.meta, meta: modifiers.control }
}

/** True when the swap would change this event; lets callers skip untouched events. */
export function modifiersNeedSwap(modifiers: SwappableModifiers): boolean {
  return modifiers.control !== modifiers.meta
}

/** Swapped copy of an Electron `before-input-event` input; returns the original when inactive. */
export function applyCtrlCmdSwapToInput<T extends SwappableModifiers>(
  input: T,
  active: boolean
): T {
  return active && modifiersNeedSwap(input) ? { ...input, ...swapCtrlCmd(input) } : input
}
