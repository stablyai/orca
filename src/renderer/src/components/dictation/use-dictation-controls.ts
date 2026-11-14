import { useEffect, useEffectEvent } from 'react'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { isPlainEscapeKeyEvent } from '../terminal-pane/input/keyboard/agent-interrupt-key-event'
import { DICTATION_CONTROL_EVENT, type DictationControlAction } from './dictation-control-events'
import type { DictationState } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

function isPlainEnterKeyEvent(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    !event.repeat &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  )
}

type DictationControlHandlers = Record<DictationControlAction, () => void> & {
  escCancels: () => boolean
  /** True when a plain Enter is held until the dictated words land, then pressed. */
  enterQueues: (event: KeyboardEvent) => boolean
}

/** Routes the shortcut, the pill's buttons, the composer mic and Esc to the session controller. */
export function useDictationControls(
  voice: GlobalSettings['voice'] | undefined,
  phase: DictationState,
  handlers: DictationControlHandlers
): void {
  const run = useEffectEvent((action: DictationControlAction) => handlers[action]())
  const escCancels = useEffectEvent(() => handlers.escCancels())
  const enterQueues = useEffectEvent((event: KeyboardEvent) => handlers.enterQueues(event))
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
  // Enter in the pane being dictated into waits for the words instead of sending a half-typed line.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isImeOwnedKeyboardEvent(event)) {
        return
      }
      if (isPlainEscapeKeyEvent(event) && escCancels()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        run('cancel')
      } else if (isPlainEnterKeyEvent(event) && enterQueues(event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    addAppKeyListener('keydown', handleKeyDown, { first: true })
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [])
}
