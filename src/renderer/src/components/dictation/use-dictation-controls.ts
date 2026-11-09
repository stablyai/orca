import { useEffect, useEffectEvent } from 'react'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { isPlainEscapeKeyEvent } from '../terminal-pane/input/keyboard/agent-interrupt-key-event'
import { DICTATION_CONTROL_EVENT, type DictationControlAction } from './dictation-control-events'
import type { DictationState } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

type DictationControlHandlers = Record<DictationControlAction, () => void> & {
  escCancels: () => boolean
}

/** Routes the shortcut, the pill's buttons, the composer mic and Esc to the session controller. */
export function useDictationControls(
  voice: GlobalSettings['voice'] | undefined,
  phase: DictationState,
  handlers: DictationControlHandlers
): void {
  const run = useEffectEvent((action: DictationControlAction) => handlers[action]())
  const escCancels = useEffectEvent(() => handlers.escCancels())
  // A failed recording stays retryable even after voice is turned off in Settings.
  const enabled = voice?.enabled === true || phase !== 'idle'
  const mainShortcut = voice?.enabled === true && voice.dictationMode !== 'hold'

  // Main intercepts Toggle presses and Auto double taps so the chord never reaches xterm.
  useEffect(() => {
    if (!mainShortcut) {
      return
    }
    return window.api.ui.onDictationKeyDown(() => run('toggle'))
  }, [mainShortcut])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const handleControl = (event: Event): void =>
      run((event as CustomEvent<DictationControlAction>).detail)
    document.addEventListener(DICTATION_CONTROL_EVENT, handleControl)
    return () => document.removeEventListener(DICTATION_CONTROL_EVENT, handleControl)
  }, [enabled])

  // Esc cancels a dictation and goes no further, so it can't also interrupt the agent.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isPlainEscapeKeyEvent(event) || isImeOwnedKeyboardEvent(event) || !escCancels()) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      run('cancel')
    }
    addAppKeyListener('keydown', handleKeyDown, { first: true })
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [])
}
