import { useEffect, type RefObject } from 'react'
import type { DictationState } from '../../../../shared/speech-types'
import { DICTATION_CONTROL_EVENT } from './dictation-control-events'

export function useDictationControl({
  enabled,
  state,
  start,
  stop
}: {
  enabled: boolean
  state: RefObject<DictationState>
  start: (conversationTarget?: Element) => Promise<void>
  stop: () => Promise<void>
}): void {
  useEffect(() => {
    const handleControl = (event: Event): void => {
      if (!enabled || state.current === 'stopping' || !(event instanceof CustomEvent)) {
        return
      }
      const action: unknown = event.detail
      if (typeof action === 'object' && action !== null) {
        if (
          'action' in action &&
          action.action === 'start' &&
          'conversationTarget' in action &&
          action.conversationTarget instanceof Element &&
          state.current === 'idle'
        ) {
          void start(action.conversationTarget)
        }
        return
      }
      const recording = state.current === 'listening' || state.current === 'starting'
      if ((action === 'start' || action === 'toggle') && state.current === 'idle') {
        void start()
      } else if ((action === 'stop' || action === 'toggle') && recording) {
        void stop()
      }
    }
    document.addEventListener(DICTATION_CONTROL_EVENT, handleControl)
    return () => document.removeEventListener(DICTATION_CONTROL_EVENT, handleControl)
  }, [enabled, state, start, stop])
}
