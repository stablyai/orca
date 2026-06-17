import { useEffect } from 'react'
import { toast } from 'sonner'
import type { DictationInsertionTarget } from './dictation-insertion-target'
import { insertText } from './dictation-insertion-target'
import { formatFinalTranscriptSegment } from './dictation-final-segments'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'
import { translate } from '@/i18n/i18n'

type DictationSpeechEventListenersParams = {
  activeSessionIdRef: React.RefObject<string | null>
  insertionTargetRef: React.RefObject<DictationInsertionTarget | null>
  finalTranscriptReceivedRef: React.RefObject<boolean>
  insertedFinalTranscriptRef: React.RefObject<string>
  stopRequestedDuringStartRef: React.RefObject<boolean>
  intentionalTargetCancellationRef: React.RefObject<boolean>
  erroredSessionIdsRef: React.RefObject<Set<string>>
  dictationRunRef: React.RefObject<number>
  stoppedSessionIdsRef: React.RefObject<Set<string>>
  stoppedResolversRef: React.RefObject<Map<string, () => void>>
  dictationStateRef: React.RefObject<string>
  setPartialTranscript: (text: string) => void
  setDictationState: (state: string) => void
  stopCapture: () => void
  discardBufferedAudio: () => void
}

export function useDictationSpeechEventListeners(
  params: DictationSpeechEventListenersParams
): void {
  const {
    activeSessionIdRef,
    insertionTargetRef,
    finalTranscriptReceivedRef,
    insertedFinalTranscriptRef,
    stopRequestedDuringStartRef,
    intentionalTargetCancellationRef,
    erroredSessionIdsRef,
    dictationRunRef,
    stoppedSessionIdsRef,
    stoppedResolversRef,
    dictationStateRef,
    setPartialTranscript,
    setDictationState,
    stopCapture,
    discardBufferedAudio
  } = params

  useEffect(() => {
    const cleanupPartial = window.api.speech.onPartialTranscript((data) => {
      if (data.sessionId !== activeSessionIdRef.current) {
        return
      }
      setPartialTranscript(data.text)
    })

    const cleanupFinal = window.api.speech.onFinalTranscript((data) => {
      if (data.sessionId !== activeSessionIdRef.current || !data.text) {
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
  }, [setPartialTranscript, setDictationState, stopCapture, discardBufferedAudio])
}
