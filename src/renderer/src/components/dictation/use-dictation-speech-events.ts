import { useEffect } from 'react'
import { toast } from 'sonner'
import type { DictationCorrectionMode, DictationState } from '../../../../shared/speech-types'
import { translate } from '@/i18n/i18n'
import { insertText, type DictationInsertionTarget } from './dictation-insertion-target'
import { formatFinalTranscriptSegment } from './dictation-final-segments'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'

type MutableRef<T> = { current: T }

type DictationSpeechEventOptions = {
  activeSessionIdRef: MutableRef<string | null>
  dictationStateRef: MutableRef<DictationState>
  insertionTargetRef: MutableRef<DictationInsertionTarget | null>
  intentionalTargetCancellationRef: MutableRef<boolean>
  finalTranscriptRef: MutableRef<string>
  finalTranscriptReceivedRef: MutableRef<boolean>
  correctionModeRef: MutableRef<DictationCorrectionMode>
  stoppedSessionIdsRef: MutableRef<Set<string>>
  stoppedResolversRef: MutableRef<Map<string, () => void>>
  erroredSessionIdsRef: MutableRef<Set<string>>
  dictationRunRef: MutableRef<number>
  stopRequestedDuringStartRef: MutableRef<boolean>
  setPartialTranscript: (text: string) => void
  setDictationState: (state: DictationState) => void
  stopCapture: () => void
  discardBufferedAudio: () => void
}

export function useDictationSpeechEvents(options: DictationSpeechEventOptions): void {
  const {
    activeSessionIdRef,
    dictationStateRef,
    insertionTargetRef,
    intentionalTargetCancellationRef,
    finalTranscriptRef,
    finalTranscriptReceivedRef,
    correctionModeRef,
    stoppedSessionIdsRef,
    stoppedResolversRef,
    erroredSessionIdsRef,
    dictationRunRef,
    stopRequestedDuringStartRef,
    setPartialTranscript,
    setDictationState,
    stopCapture,
    discardBufferedAudio
  } = options

  useEffect(() => {
    const cleanupPartial = window.api.speech.onPartialTranscript((data) => {
      if (data.sessionId === activeSessionIdRef.current) {
        setPartialTranscript(data.text)
      }
    })

    const cleanupFinal = window.api.speech.onFinalTranscript((data) => {
      if (data.sessionId !== activeSessionIdRef.current || !data.text) {
        return
      }
      setPartialTranscript('')
      finalTranscriptReceivedRef.current = true
      const textToInsert = formatFinalTranscriptSegment(data.text, finalTranscriptRef.current)
      finalTranscriptRef.current += textToInsert
      const target = insertionTargetRef.current
      if (correctionModeRef.current === 'off' && target) {
        insertText(textToInsert, target)
      } else if (correctionModeRef.current === 'off' && !intentionalTargetCancellationRef.current) {
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
        finalTranscriptRef.current = ''
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
    correctionModeRef,
    dictationRunRef,
    dictationStateRef,
    discardBufferedAudio,
    erroredSessionIdsRef,
    finalTranscriptReceivedRef,
    finalTranscriptRef,
    insertionTargetRef,
    intentionalTargetCancellationRef,
    setDictationState,
    setPartialTranscript,
    stopCapture,
    stoppedResolversRef,
    stoppedSessionIdsRef,
    stopRequestedDuringStartRef
  ])
}
