import type { KeybindingOverrides, KeybindingPlatform } from './types'
import { KEYBINDING_PLATFORMS, isKeybindingActionId } from './definitions'
import { parseKeybinding } from './parser'

const MOUSE_KEY_TOKENS: ReadonlySet<string> = new Set(['MouseBack', 'MouseForward'])

export function isMouseKeyToken(key: string): boolean {
  return MOUSE_KEY_TOKENS.has(key)
}

export function isMouseBinding(binding: string): boolean {
  const parsed = parseKeybinding(binding)
  return parsed ? isMouseKeyToken(parsed.key) : false
}

export type BindingsByInputKind = { keyboard: string[]; mouse: string[] }

/**
 * Why: a reader that predates a binding token drops the whole action instead of
 * the single entry it cannot parse, so a mouse binding stored alongside an
 * action's keyboard chords takes them down with it on a downgrade. Persisting
 * the two kinds in separate sections keeps the keyboard list readable by every
 * build; `unionKeybindingOverrides` puts them back together on read.
 */
export function splitBindingsByInputKind(bindings: readonly string[]): BindingsByInputKind {
  const keyboard: string[] = []
  const mouse: string[] = []
  for (const binding of bindings) {
    if (isMouseBinding(binding)) {
      mouse.push(binding)
    } else {
      keyboard.push(binding)
    }
  }
  return { keyboard, mouse }
}

export function splitOverridesByInputKind(overrides: KeybindingOverrides): {
  keyboard: KeybindingOverrides
  mouse: KeybindingOverrides
} {
  const keyboard: KeybindingOverrides = {}
  const mouse: KeybindingOverrides = {}
  for (const [actionId, bindings] of Object.entries(overrides)) {
    if (!isKeybindingActionId(actionId)) {
      continue
    }
    const split = splitBindingsByInputKind(bindings ?? [])
    keyboard[actionId] = split.keyboard
    if (split.mouse.length > 0) {
      mouse[actionId] = split.mouse
    }
  }
  return { keyboard, mouse }
}

/** Rejoins the split sections into one list per action, keyboard bindings first. */
export function unionKeybindingOverrides(
  keyboard: KeybindingOverrides,
  mouse: KeybindingOverrides
): KeybindingOverrides {
  const merged: KeybindingOverrides = { ...keyboard }
  for (const [actionId, mouseBindings] of Object.entries(mouse)) {
    if (!isKeybindingActionId(actionId)) {
      continue
    }
    const combined = [...(merged[actionId] ?? [])]
    for (const binding of mouseBindings ?? []) {
      if (!combined.includes(binding)) {
        combined.push(binding)
      }
    }
    merged[actionId] = combined
  }
  return merged
}

export function unionPlatformKeybindingOverrides(
  keyboard: Partial<Record<KeybindingPlatform, KeybindingOverrides>>,
  mouse: Partial<Record<KeybindingPlatform, KeybindingOverrides>>
): Partial<Record<KeybindingPlatform, KeybindingOverrides>> {
  const merged: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const platform of KEYBINDING_PLATFORMS) {
    const platformKeyboard = keyboard[platform]
    const platformMouse = mouse[platform]
    // Keep an absent section absent: callers distinguish "no section" from "empty section".
    if (!platformKeyboard && !platformMouse) {
      continue
    }
    merged[platform] = unionKeybindingOverrides(platformKeyboard ?? {}, platformMouse ?? {})
  }
  return merged
}
