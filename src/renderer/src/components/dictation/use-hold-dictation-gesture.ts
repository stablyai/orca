import { useEffect, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import type { DictationState } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/types'
import type { DictationInsertionTarget } from './dictation-insertion-target'

type HoldReleaseGesture = {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

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

function normalizeEventKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

function captureReleaseGesture(e: KeyboardEvent): HoldReleaseGesture {
  return {
    key: normalizeEventKey(e.key),
    code: e.code,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey
  }
}

function keyReleased(e: KeyboardEvent, gesture: HoldReleaseGesture): boolean {
  return normalizeEventKey(e.key) === gesture.key || (e.code !== '' && e.code === gesture.code)
}

function requiredModifierReleased(e: KeyboardEvent, gesture: HoldReleaseGesture): boolean {
  switch (e.key) {
    case 'Meta':
      return gesture.metaKey
    case 'Control':
      return gesture.ctrlKey
    case 'Alt':
      return gesture.altKey
    case 'Shift':
      return gesture.shiftKey
    default:
      return false
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
  // Why: hold mode uses renderer-side DOM events instead of the IPC path
  // (before-input-event). Electron suppresses keyUp after preventDefault()
  // there, so the renderer owns both press and release.
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? 'toggle'
    if (mode !== 'hold') {
      return
    }
    // Why: keyUp can arrive after the modifier is already released, so the
    // original shortcut no longer matches even though the held chord ended.
    let activeReleaseGesture: HoldReleaseGesture | null = null

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (keybindingMatchesAction('voice.dictation', e, getShortcutPlatform(), keybindings)) {
        if (!settings?.voice?.enabled || !settings.voice.sttModel) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        holdGestureActiveRef.current = true
        activeReleaseGesture = captureReleaseGesture(e)
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
        !activeReleaseGesture ||
        (!keyReleased(e, activeReleaseGesture) &&
          !requiredModifierReleased(e, activeReleaseGesture))
      ) {
        return
      }
      if (dictationStateRef.current === 'idle' || dictationStateRef.current === 'stopping') {
        holdGestureActiveRef.current = false
        activeReleaseGesture = null
        return
      }
      holdGestureActiveRef.current = false
      activeReleaseGesture = null
      void stopDictation()
    }

    const handleBlur = (): void => {
      if (!holdGestureActiveRef.current) {
        return
      }
      holdGestureActiveRef.current = false
      activeReleaseGesture = null
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
