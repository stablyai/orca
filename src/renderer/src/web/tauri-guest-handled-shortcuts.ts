import { useEffect, useRef } from 'react'
import { KEYBINDING_DEFINITIONS } from '../../../shared/keybindings/definitions'
import { getEffectiveKeybindingsForDefinition } from '../../../shared/keybindings/effective'
import { platformModifiers } from '../../../shared/keybindings/matching-key'
import { parseKeybinding } from '../../../shared/keybindings/parser'
import type { KeybindingOverrides } from '../../../shared/keybindings/types'
import { useAppStore } from '../store'
import { shortcutPlatform } from '../app-shell/chrome/app-window-chrome'
import { emitNative, invokeNative, isTauriNativeHost } from './tauri-native-host'

// Why: the guest init script suppresses its own default handling only for
// chords in this set, so the app must publish exactly the chords its
// keybinding registry consumes. Entry format mirrors the guest matcher:
// `c:<ctrl><alt><shift><meta>:<code>` for physical codes and
// `k:<ctrl><alt><shift><meta>:<TOKEN>` for logical single-char keys.
export const EVENT_BROWSER_HANDLED_SHORTCUTS = 'browser:handled-shortcuts'

export type TauriGuestHandledShortcutSource = {
  platform: NodeJS.Platform
  overrides?: KeybindingOverrides
}

function chordEntriesForKey(key: string, bits: string): string[] {
  if (key.length === 1 && key >= 'A' && key <= 'Z') {
    return [`c:${bits}:Key${key}`, `k:${bits}:${key}`]
  }
  if (key.length === 1 && key >= '0' && key <= '9') {
    return [`c:${bits}:Digit${key}`, `k:${bits}:${key}`]
  }
  switch (key) {
    case 'Space':
      return [`c:${bits}:Space`, `k:${bits}:Space`]
    case 'Plus':
      return [`c:${bits}:Equal`, `k:${bits}:+`]
    case 'Minus':
      return [`c:${bits}:Minus`, `k:${bits}:-`]
    case 'Equal':
      return [`c:${bits}:Equal`, `k:${bits}:=`]
    case 'Underscore':
      return [`c:${bits}:Minus`, `k:${bits}:_`]
    default:
      break
  }
  // Named codes (Escape, Enter, Tab, F-keys, arrows) match guest event.code.
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
    return [`c:${bits}:${key}`]
  }
  return []
}

export function computeTauriGuestHandledShortcuts(
  source: TauriGuestHandledShortcutSource
): string[] {
  const chords = new Set<string>()
  for (const definition of KEYBINDING_DEFINITIONS) {
    let bindings: string[]
    try {
      bindings = getEffectiveKeybindingsForDefinition(definition, source.platform, source.overrides)
    } catch {
      // Best effort: one unreadable definition must not drop the whole set.
      continue
    }
    for (const binding of bindings) {
      const parsed = parseKeybinding(binding)
      // Double-tap chords never reach the guest as key events.
      if (!parsed || !parsed.key || parsed.doubleTapModifier) {
        continue
      }
      const modifiers = platformModifiers(parsed, source.platform)
      const bits = `${modifiers.control ? '1' : '0'}${modifiers.alt ? '1' : '0'}${modifiers.shift ? '1' : '0'}${modifiers.meta ? '1' : '0'}`
      for (const entry of chordEntriesForKey(parsed.key, bits)) {
        chords.add(entry)
      }
    }
  }
  return [...chords].sort()
}

export async function publishTauriGuestHandledShortcuts(chords: string[]): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  await invokeNative('poc_browser_set_handled_shortcuts', { args: { chords } })
  await emitNative(EVENT_BROWSER_HANDLED_SHORTCUTS, { chords })
}

// Why: guests pull the current set on init, so publishing only on registry
// changes keeps every live guest suppression in sync without polling.
export function useTauriGuestHandledShortcuts(): void {
  const keybindings = useAppStore((s) => s.keybindings)
  const lastPublished = useRef<string | null>(null)
  useEffect(() => {
    if (!isTauriNativeHost()) {
      return
    }
    const chords = computeTauriGuestHandledShortcuts({
      platform: shortcutPlatform,
      overrides: keybindings
    })
    const fingerprint = chords.join('\n')
    if (lastPublished.current === fingerprint) {
      return
    }
    lastPublished.current = fingerprint
    void publishTauriGuestHandledShortcuts(chords).catch(() => {})
  }, [keybindings])
}
