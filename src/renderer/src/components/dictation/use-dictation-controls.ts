import { useEffect, useEffectEvent } from 'react'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { isPlainEscapeKeyEvent } from '../terminal-pane/input/keyboard/agent-interrupt-key-event'
import { DICTATION_CONTROL_EVENT, type DictationControlAction } from './dictation-control-events'

type DictationControlHandlers = Record<DictationControlAction, () => void> & {
  pillShown: () => boolean
}

/** Routes the pill's buttons, the composer mic and Esc to the session controller. */
export function useDictationControls(enabled: boolean, handlers: DictationControlHandlers): void {
  const run = useEffectEvent((action: DictationControlAction) => handlers[action]())
  const pillShown = useEffectEvent(() => handlers.pillShown())

  useEffect(() => {
    if (!enabled) {
      return
    }
    const handleControl = (event: Event): void =>
      run((event as CustomEvent<DictationControlAction>).detail)
    document.addEventListener(DICTATION_CONTROL_EVENT, handleControl)
    return () => document.removeEventListener(DICTATION_CONTROL_EVENT, handleControl)
  }, [enabled])

  // Esc cancels while the pill shows and goes no further, so it can't also interrupt the agent.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isPlainEscapeKeyEvent(event) || isImeOwnedKeyboardEvent(event) || !pillShown()) {
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
