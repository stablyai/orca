import { useEffect, useRef, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import type { DictationState } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/types'
import type { DictationInsertionTarget } from './dictation-insertion-target'

type HoldDictationGestureOptions = {
  dictationStateRef: MutableRefObject<DictationState>
  holdGestureActiveRef: MutableRefObject<boolean>
  insertionTargetRef: MutableRefObject<DictationInsertionTarget | null>
  intentionalTargetCancellationRef: MutableRefObject<boolean>
  keybindings: KeybindingOverrides
  settings: GlobalSettings | null
  startDictation: () => Promise<void> | void
  stopDictation: () => Promise<void> | void
}

type HoldDictationReleaseMatcher = (event: KeyboardEvent) => boolean

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
    // Why: modifier state can already be false on the keyup that ends a chord,
    // so release matching tracks the accepted keydown's key identity instead.
    const releasePrimaryCode = getReleasedPrimaryCode(releaseEvent)
    if (primaryCode !== null && releasePrimaryCode !== null) {
      return releasePrimaryCode === primaryCode
    }
    return primaryKey !== null && getReleasedPrimaryKey(releaseEvent) === primaryKey
  }
}

export function useHoldDictationGesture({
  dictationStateRef,
  holdGestureActiveRef,
  insertionTargetRef,
  intentionalTargetCancellationRef,
  keybindings,
  settings,
  startDictation,
  stopDictation
}: HoldDictationGestureOptions): void {
  const releaseMatcherRef = useRef<HoldDictationReleaseMatcher | null>(null)

  // Why: hold mode uses renderer-side DOM events instead of the IPC path
  // (before-input-event). Electron suppresses keyUp after preventDefault()
  // there, so the renderer owns both press and release.
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? 'toggle'
    if (mode !== 'hold') {
      return
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (keybindingMatchesAction('voice.dictation', e, getShortcutPlatform(), keybindings)) {
        if (!settings?.voice?.enabled || !settings.voice.sttModel) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        holdGestureActiveRef.current = true
        releaseMatcherRef.current = createHoldDictationReleaseMatcher(e)
        if (dictationStateRef.current === 'idle') {
          void startDictation()
        }
      }
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (!holdGestureActiveRef.current) {
        return
      }
      if (
        !keybindingMatchesAction('voice.dictation', e, getShortcutPlatform(), keybindings) &&
        releaseMatcherRef.current?.(e) !== true
      ) {
        return
      }
      releaseMatcherRef.current = null
      if (dictationStateRef.current === 'idle' || dictationStateRef.current === 'stopping') {
        holdGestureActiveRef.current = false
        return
      }
      holdGestureActiveRef.current = false
      void stopDictation()
    }

    const handleBlur = (): void => {
      if (!holdGestureActiveRef.current) {
        return
      }
      holdGestureActiveRef.current = false
      releaseMatcherRef.current = null
      if (dictationStateRef.current !== 'idle' && dictationStateRef.current !== 'stopping') {
        insertionTargetRef.current = null
        intentionalTargetCancellationRef.current = true
        void stopDictation()
      }
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') {
        handleBlur()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      handleBlur()
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    settings?.voice?.dictationMode,
    settings?.voice?.enabled,
    settings?.voice?.sttModel,
    keybindings,
    startDictation,
    stopDictation,
    dictationStateRef,
    holdGestureActiveRef,
    insertionTargetRef,
    intentionalTargetCancellationRef
  ])
}
