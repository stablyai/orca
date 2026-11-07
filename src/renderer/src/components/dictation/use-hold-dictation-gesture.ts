import { useEffect, useEffectEvent, useRef } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

type HoldDictationGestureOptions = {
  canStartDictation: () => boolean
  keybindings: KeybindingOverrides
  settings: GlobalSettings | null
  startDictation: () => Promise<void> | void
  stopDictation: () => Promise<void> | void
}

type HoldDictationReleaseMatcher = (event: KeyboardEvent) => boolean

type ActiveHold = {
  matchesRelease: HoldDictationReleaseMatcher
  startedDictation: boolean
}

type HeldModifiers = {
  alt: boolean
  control: boolean
  meta: boolean
  shift: boolean
}

const MODIFIER_KEYS_BY_NAME: Partial<Record<string, keyof HeldModifiers>> = {
  Alt: 'alt',
  AltGraph: 'alt',
  Control: 'control',
  Ctrl: 'control',
  Meta: 'meta',
  OS: 'meta',
  Shift: 'shift'
}

const UNRELIABLE_KEY_VALUES = new Set(['', 'Dead', 'Unidentified'])
const UNRELIABLE_CODE_VALUES = new Set(['', 'Unidentified'])

function normalizeReleasedKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

function getReleasedModifier(event: KeyboardEvent): keyof HeldModifiers | null {
  const byKey = MODIFIER_KEYS_BY_NAME[event.key]
  if (byKey) {
    return byKey
  }
  if (event.code.startsWith('Alt')) {
    return 'alt'
  }
  if (event.code.startsWith('Control')) {
    return 'control'
  }
  if (event.code.startsWith('Meta')) {
    return 'meta'
  }
  if (event.code.startsWith('Shift')) {
    return 'shift'
  }
  return null
}

function getReleasedPrimaryKey(event: KeyboardEvent): string | null {
  if (getReleasedModifier(event)) {
    return null
  }
  const key = normalizeReleasedKey(event.key)
  return UNRELIABLE_KEY_VALUES.has(key) ? null : key
}

function getReleasedPrimaryCode(event: KeyboardEvent): string | null {
  if (getReleasedModifier(event) || UNRELIABLE_CODE_VALUES.has(event.code)) {
    return null
  }
  return event.code
}

function createHoldDictationReleaseMatcher(event: KeyboardEvent): HoldDictationReleaseMatcher {
  const primaryKey = getReleasedPrimaryKey(event)
  const primaryCode = getReleasedPrimaryCode(event)
  const heldModifiers: HeldModifiers = {
    alt: event.altKey,
    control: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey
  }

  return (releaseEvent) => {
    const releasedModifier = getReleasedModifier(releaseEvent)
    if (releasedModifier) {
      return heldModifiers[releasedModifier]
    }
    // Modifiers may already be released at keyup; match the accepted keydown’s primary key identity.
    const releasePrimaryCode = getReleasedPrimaryCode(releaseEvent)
    if (primaryCode !== null && releasePrimaryCode !== null) {
      return releasePrimaryCode === primaryCode
    }
    return primaryKey !== null && getReleasedPrimaryKey(releaseEvent) === primaryKey
  }
}

export function useHoldDictationGesture({
  canStartDictation,
  keybindings,
  settings,
  startDictation,
  stopDictation
}: HoldDictationGestureOptions): void {
  const activeHoldRef = useRef<ActiveHold | null>(null)
  const mode = settings?.voice?.dictationMode ?? 'toggle'
  const enabled = settings?.voice?.enabled === true
  // Settings and keybinding refreshes re-create these inputs; re-running the effect would end a held dictation.
  const start = useEffectEvent(() => void startDictation())
  const stop = useEffectEvent(() => void stopDictation())
  const canStart = useEffectEvent(() => canStartDictation())
  const matchesShortcut = useEffectEvent((e: KeyboardEvent) =>
    keybindingMatchesAction('voice.dictation', e, getShortcutPlatform(), keybindings)
  )

  // Hold mode owns DOM press/release events; main before-input-event suppresses keyup after preventDefault.
  useEffect(() => {
    if (mode !== 'hold' || !enabled) {
      return
    }

    // Losing the release (blur, hidden, mode change) still stops, which inserts what was said.
    const endHold = (): void => {
      if (!activeHoldRef.current) {
        return
      }
      activeHoldRef.current = null
      stop()
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!matchesShortcut(e)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) {
        activeHoldRef.current = {
          matchesRelease: createHoldDictationReleaseMatcher(e),
          startedDictation: false
        }
      }
      const hold = activeHoldRef.current
      // One dictation per press: key repeat after an automatic stop must not start another.
      if (hold && !hold.startedDictation && canStart()) {
        hold.startedDictation = true
        start()
      }
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      const hold = activeHoldRef.current
      if (hold && (matchesShortcut(e) || hold.matchesRelease(e))) {
        endHold()
      }
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') {
        endHold()
      }
    }

    addAppKeyListener('keydown', handleKeyDown)
    addAppKeyListener('keyup', handleKeyUp)
    window.addEventListener('blur', endHold)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      endHold()
      removeAppKeyListener('keydown', handleKeyDown)
      removeAppKeyListener('keyup', handleKeyUp)
      window.removeEventListener('blur', endHold)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [mode, enabled])
}
