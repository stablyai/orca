import { useCallback, useEffect, type MutableRefObject } from 'react'
import type { DictationState } from '../../../../shared/speech-types'
import { applyDictationControlAction } from './dictation-control-actions'
import { DICTATION_CONTROL_EVENT, type DictationControlAction } from './dictation-control-events'

type UseDictationUtteranceControlsArgs = {
  dictationStateRef: MutableRefObject<DictationState>
  activeSessionIdRef: MutableRefObject<string | null>
  clearingUtteranceRef: MutableRefObject<boolean>
  pauseRequestedDuringStartRef: MutableRefObject<boolean>
  sessionReadyRef: MutableRefObject<boolean>
  pauseCapture: () => void
  resumeCapture: () => void
  clearLiveAudio: () => void
  setDictationState: (state: DictationState) => void
  setPartialTranscript: (text: string) => void
  startDictation: () => Promise<void>
  stopDictation: () => Promise<void>
  enabled: boolean
}

export function useDictationUtteranceControls({
  dictationStateRef,
  activeSessionIdRef,
  clearingUtteranceRef,
  pauseRequestedDuringStartRef,
  sessionReadyRef,
  pauseCapture,
  resumeCapture,
  clearLiveAudio,
  setDictationState,
  setPartialTranscript,
  startDictation,
  stopDictation,
  enabled
}: UseDictationUtteranceControlsArgs): void {
  const pauseDictation = useCallback(() => {
    if (dictationStateRef.current === 'starting') {
      pauseRequestedDuringStartRef.current = true
      pauseCapture()
      dictationStateRef.current = 'paused'
      setDictationState('paused')
      return
    }
    if (dictationStateRef.current !== 'listening') {
      return
    }
    pauseCapture()
    dictationStateRef.current = 'paused'
    setDictationState('paused')
  }, [dictationStateRef, pauseCapture, pauseRequestedDuringStartRef, setDictationState])

  const resumeDictation = useCallback(() => {
    if (dictationStateRef.current !== 'paused') {
      return
    }
    pauseRequestedDuringStartRef.current = false
    resumeCapture()
    if (!sessionReadyRef.current) {
      dictationStateRef.current = 'starting'
      setDictationState('starting')
      return
    }
    dictationStateRef.current = 'listening'
    setDictationState('listening')
  }, [
    dictationStateRef,
    pauseRequestedDuringStartRef,
    resumeCapture,
    sessionReadyRef,
    setDictationState
  ])

  const clearUtterance = useCallback(async () => {
    const sessionId = activeSessionIdRef.current
    const state = dictationStateRef.current
    if (!sessionId || (state !== 'listening' && state !== 'paused' && state !== 'starting')) {
      return
    }
    clearingUtteranceRef.current = true
    setPartialTranscript('')
    clearLiveAudio()
    try {
      await window.api.speech.clearDictation(sessionId)
    } catch {
      // Why: the worker may not exist yet during Starting; keep the pill open.
    } finally {
      if (activeSessionIdRef.current === sessionId) {
        clearingUtteranceRef.current = false
      }
    }
  }, [
    activeSessionIdRef,
    clearLiveAudio,
    clearingUtteranceRef,
    dictationStateRef,
    setPartialTranscript
  ])

  useEffect(() => {
    const handleControl = (event: Event): void => {
      if (!enabled || dictationStateRef.current === 'stopping') {
        return
      }
      applyDictationControlAction(
        (event as CustomEvent<DictationControlAction>).detail,
        dictationStateRef.current,
        {
          startDictation: () => void startDictation(),
          stopDictation: () => void stopDictation(),
          pauseDictation,
          resumeDictation,
          clearUtterance: () => void clearUtterance()
        }
      )
    }
    document.addEventListener(DICTATION_CONTROL_EVENT, handleControl)
    return () => document.removeEventListener(DICTATION_CONTROL_EVENT, handleControl)
  }, [
    clearUtterance,
    dictationStateRef,
    enabled,
    pauseDictation,
    resumeDictation,
    startDictation,
    stopDictation
  ])
}
