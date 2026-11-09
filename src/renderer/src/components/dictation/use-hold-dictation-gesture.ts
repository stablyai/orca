import { useEffect, useEffectEvent, useRef } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'

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
  pressedAt: number
  /** Key repeat showed the key still down past the Auto threshold. */
  repeatedPastThreshold: boolean
  startedDictation: boolean
}

// Auto: a press held this long records until release; a shorter tap leaves dictation running.
const AUTO_HOLD_THRESHOLD_MS = 300

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

function isTerminalInputTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
}

export function useHoldDictationGesture({
  canStartDictation,
  keybindings,
  settings,
  startDictation,
  stopDictation
}: HoldDictationGestureOptions): void {
  const activeHoldRef = useRef<ActiveHold | null>(null)
  const mode = settings?.voice?.dictationMode ?? 'auto'
  const enabled = settings?.voice?.enabled === true
  // Settings and keybinding refreshes re-create these inputs; re-running the effect would end a held dictation.
  const start = useEffectEvent(() => void startDictation())
  const stop = useEffectEvent(() => void stopDictation())
  const canStart = useEffectEvent(() => canStartDictation())
  // Main forwards Hold and Auto presses, so the terminal shortcut policy it would apply is applied here.
  const matchesShortcut = useEffectEvent((e: KeyboardEvent) =>
    keybindingMatchesAction('voice.dictation', e, getShortcutPlatform(), keybindings, {
      context: isTerminalInputTarget(e.target) ? 'terminal' : 'app',
      terminalShortcutPolicy: settings?.terminalShortcutPolicy
    })
  )
  const notifyTerminalCapture = useEffectEvent(() =>
    showTerminalShortcutCaptureNotification({
      actionId: 'voice.dictation',
      platform: getShortcutPlatform(),
      keybindings
    })
  )

  // Hold and Auto own DOM press/release events; main before-input-event suppresses keyup after preventDefault.
  useEffect(() => {
    if (mode === 'toggle' || !enabled) {
      return
    }

    // Losing the release (blur, hidden, mode change) ends the press, which inserts what was said.
    // releasedAt is null when the key's own release time is unknown; only key repeat then proves an Auto hold.
    const endHold = (releasedAt: number | null = null): void => {
      const hold = activeHoldRef.current
      if (!hold) {
        return
      }
      activeHoldRef.current = null
      const held =
        hold.repeatedPastThreshold ||
        (releasedAt !== null && releasedAt - hold.pressedAt >= AUTO_HOLD_THRESHOLD_MS)
      if (mode === 'hold' || (hold.startedDictation && held)) {
        stop()
      }
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      // keyCode 229: IME keydowns that some engines send without isComposing.
      if (e.isComposing || e.keyCode === 229 || !matchesShortcut(e)) {
        return
      }
      if (e.target instanceof Element && e.target.closest('[data-shortcut-recorder-active]')) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) {
        if (isTerminalInputTarget(e.target)) {
          notifyTerminalCapture()
        }
        // macOS drops the shortcut key's keyup while Cmd is held, so every fresh press starts over.
        activeHoldRef.current = null
        if (mode === 'auto' && !canStart()) {
          // A tap started this dictation; the next press ends it.
          stop()
          return
        }
        activeHoldRef.current = {
          matchesRelease: createHoldDictationReleaseMatcher(e),
          pressedAt: performance.now(),
          repeatedPastThreshold: false,
          startedDictation: false
        }
      }
      const hold = activeHoldRef.current
      if (hold && e.repeat && performance.now() - hold.pressedAt >= AUTO_HOLD_THRESHOLD_MS) {
        hold.repeatedPastThreshold = true
      }
      // One dictation per press: key repeat after an automatic stop must not start another.
      if (hold && !hold.startedDictation && canStart()) {
        hold.startedDictation = true
        start()
      }
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      const hold = activeHoldRef.current
      if (hold && (matchesShortcut(e) || hold.matchesRelease(e))) {
        // macOS drops the key's keyup while Cmd is held, so a Cmd keyup says nothing about when the key went up.
        endHold(getReleasedModifier(e) === 'meta' ? null : performance.now())
      }
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') {
        endHold()
      }
    }
    const handleBlur = (): void => endHold()

    addAppKeyListener('keydown', handleKeyDown)
    addAppKeyListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      endHold()
      removeAppKeyListener('keydown', handleKeyDown)
      removeAppKeyListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [mode, enabled])
}
