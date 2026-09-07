import { useEffect, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { insertText, type DictationInsertionTarget } from './dictation-insertion-target'
import { formatFinalTranscriptSegment } from './dictation-final-segments'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'
import type { DictationState } from '../../../../shared/speech-types'

type UseDictationTranscriptListenersArgs = {
  activeSessionIdRef: MutableRefObject<string | null>
  clearingUtteranceRef: MutableRefObject<boolean>
  finalTranscriptReceivedRef: MutableRefObject<boolean>
  insertionTargetRef: MutableRefObject<DictationInsertionTarget | null>
  insertedFinalTranscriptRef: MutableRefObject<string>
  intentionalTargetCancellationRef: MutableRefObject<boolean>
  erroredSessionIdsRef: MutableRefObject<Set<string>>
  dictationRunRef: MutableRefObject<number>
  dictationStateRef: MutableRefObject<DictationState>
  stoppedSessionIdsRef: MutableRefObject<Set<string>>
  stoppedResolversRef: MutableRefObject<Map<string, () => void>>
  stopRequestedDuringStartRef: MutableRefObject<boolean>
  pauseRequestedDuringStartRef: MutableRefObject<boolean>
  sessionReadyRef: MutableRefObject<boolean>
  setPartialTranscript: (text: string) => void
  setDictationState: (state: DictationState) => void
  stopCapture: () => void
  discardBufferedAudio: () => void
}

export function useDictationTranscriptListeners({
  activeSessionIdRef,
  clearingUtteranceRef,
  finalTranscriptReceivedRef,
  insertionTargetRef,
  insertedFinalTranscriptRef,
  intentionalTargetCancellationRef,
  erroredSessionIdsRef,
  dictationRunRef,
  dictationStateRef,
  stoppedSessionIdsRef,
  stoppedResolversRef,
  stopRequestedDuringStartRef,
  pauseRequestedDuringStartRef,
  sessionReadyRef,
  setPartialTranscript,
  setDictationState,
  stopCapture,
  discardBufferedAudio
}: UseDictationTranscriptListenersArgs): void {
  useEffect(() => {
    const cleanupPartial = window.api.speech.onPartialTranscript((data) => {
      if (data.sessionId !== activeSessionIdRef.current || clearingUtteranceRef.current) {
        return
      }
      setPartialTranscript(data.text)
    })

    const cleanupFinal = window.api.speech.onFinalTranscript((data) => {
      if (
        data.sessionId !== activeSessionIdRef.current ||
        !data.text ||
        clearingUtteranceRef.current
      ) {
        return
      }
      setPartialTranscript('')
      finalTranscriptReceivedRef.current = true
      const target = insertionTargetRef.current
      if (target) {
        const textToInsert = formatFinalTranscriptSegment(
          data.text,
          insertedFinalTranscriptRef.current
        )
        insertText(textToInsert, target)
        insertedFinalTranscriptRef.current += textToInsert
      } else if (!intentionalTargetCancellationRef.current) {
        toast.message(
          translate(
            'auto.components.dictation.DictationController.7afff43472',
            'Dictation finished, but no text field was focused.'
          )
        )
      }
    })

    const cleanupStopped = window.api.speech.onStopped((data) => {
      recordStoppedSession(data.sessionId, stoppedSessionIdsRef, stoppedResolversRef)
    })

    const cleanupError = window.api.speech.onError((data) => {
      if (data.sessionId !== activeSessionIdRef.current) {
        return
      }
      const sessionId = data.sessionId
      erroredSessionIdsRef.current.add(sessionId)
      dictationRunRef.current += 1
      activeSessionIdRef.current = null
      toast.error(
        translate(
          'auto.components.dictation.DictationController.de136f1199',
          'Speech error: {{value0}}',
          { value0: data.error }
        )
      )
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      stopCapture()
      discardBufferedAudio()
      void (async () => {
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
        insertionTargetRef.current = null
        intentionalTargetCancellationRef.current = false
        stopRequestedDuringStartRef.current = false
        pauseRequestedDuringStartRef.current = false
        sessionReadyRef.current = false
        finalTranscriptReceivedRef.current = false
        insertedFinalTranscriptRef.current = ''
        dictationStateRef.current = 'idle'
        setDictationState('idle')
        setPartialTranscript('')
      })()
    })

    return () => {
      cleanupPartial()
      cleanupFinal()
      cleanupStopped()
      cleanupError()
    }
  }, [
    activeSessionIdRef,
    clearingUtteranceRef,
    discardBufferedAudio,
    dictationRunRef,
    dictationStateRef,
    erroredSessionIdsRef,
    finalTranscriptReceivedRef,
    insertedFinalTranscriptRef,
    insertionTargetRef,
    intentionalTargetCancellationRef,
    pauseRequestedDuringStartRef,
    sessionReadyRef,
    setDictationState,
    setPartialTranscript,
    stopCapture,
    stopRequestedDuringStartRef,
    stoppedResolversRef,
    stoppedSessionIdsRef
  ])
}
