import type { DictationState } from '../../../../shared/speech-types'
import type { DictationControlAction } from './dictation-control-events'

type DictationControlHandlers = {
  startDictation: () => void
  stopDictation: () => void
  pauseDictation: () => void
  resumeDictation: () => void
  clearUtterance: () => void
}

export function canStopDictationSession(state: DictationState): boolean {
  return state === 'listening' || state === 'starting' || state === 'paused'
}

export function applyDictationControlAction(
  action: DictationControlAction,
  state: DictationState,
  handlers: DictationControlHandlers
): void {
  if (action === 'start') {
    if (state === 'idle') {
      handlers.startDictation()
    }
    return
  }
  if (action === 'stop') {
    if (canStopDictationSession(state)) {
      handlers.stopDictation()
    }
    return
  }
  if (action === 'pause') {
    handlers.pauseDictation()
    return
  }
  if (action === 'resume') {
    handlers.resumeDictation()
    return
  }
  if (action === 'clear') {
    handlers.clearUtterance()
    return
  }
  if (canStopDictationSession(state)) {
    handlers.stopDictation()
    return
  }
  handlers.startDictation()
}
