import { useEffect } from 'react'
import { toast } from 'sonner'
import type { DictationState } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { formatFinalTranscriptSegment } from './dictation-final-segments'
import { insertText, type DictationInsertionTarget } from './dictation-insertion-target'
import { getRecoverableDictationText } from './dictation-recovery'
import { retryRecoveredAudioDictation } from './dictation-recovery-actions'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'

type RefLike<T> = { current: T }

type UseDictationSpeechEventsOptions = {
  settings: GlobalSettings | null
  dictationRunRef: RefLike<number>
  activeSessionIdRef: RefLike<string | null>
  insertionTargetRef: RefLike<DictationInsertionTarget | null>
  stoppedSessionIdsRef: RefLike<Set<string>>
  stoppedResolversRef: RefLike<Map<string, () => void>>
  stopRequestedDuringStartRef: RefLike<boolean>
  finalTranscriptReceivedRef: RefLike<boolean>
  erroredSessionIdsRef: RefLike<Set<string>>
  intentionalTargetCancellationRef: RefLike<boolean>
  insertedFinalTranscriptRef: RefLike<string>
  partialTranscriptRef: RefLike<string>
  dictationStateRef: RefLike<DictationState>
  setPartialTranscript: (text: string) => void
  setDictationState: (state: DictationState) => void
  stopCapture: () => void
  getRecoveryAudioChunks: () => { samples: Float32Array; sampleRate: number; sessionId: string }[]
  clearRecoveryAudio: () => void
  restoreDictationOutput: (sessionId: string) => Promise<void>
  setDictationNotice: (notice: {
    kind: 'info' | 'error'
    message: string
    createdAt: number
  }) => void
}

export function useDictationSpeechEvents({
  settings,
  dictationRunRef,
  activeSessionIdRef,
  insertionTargetRef,
  stoppedSessionIdsRef,
  stoppedResolversRef,
  stopRequestedDuringStartRef,
  finalTranscriptReceivedRef,
  erroredSessionIdsRef,
  intentionalTargetCancellationRef,
  insertedFinalTranscriptRef,
  partialTranscriptRef,
  dictationStateRef,
  setPartialTranscript,
  setDictationState,
  stopCapture,
  getRecoveryAudioChunks,
  clearRecoveryAudio,
  restoreDictationOutput,
  setDictationNotice
}: UseDictationSpeechEventsOptions): void {
  useEffect(() => {
    const cleanupPartial = window.api.speech.onPartialTranscript((data) => {
      if (data.sessionId !== activeSessionIdRef.current) {
        return
      }
      partialTranscriptRef.current = data.text
      setPartialTranscript(data.text)
    })

    const cleanupFinal = window.api.speech.onFinalTranscript((data) => {
      if (data.sessionId !== activeSessionIdRef.current || !data.text) {
        return
      }
      partialTranscriptRef.current = ''
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
      const recoveryText = getRecoverableDictationText(
        insertedFinalTranscriptRef.current,
        partialTranscriptRef.current
      )
      const recoveryAudioChunks = getRecoveryAudioChunks()
      const recoveryTarget = insertionTargetRef.current
      erroredSessionIdsRef.current.add(sessionId)
      dictationRunRef.current += 1
      activeSessionIdRef.current = null
      const recoveryAction =
        recoveryText.length > 0
          ? {
              label: translate(
                'auto.components.dictation.DictationController.copyRecoveryTranscript',
                'Copy transcript'
              ),
              onClick: () => void navigator.clipboard?.writeText(recoveryText)
            }
          : recoveryAudioChunks.length > 0
            ? {
                label: translate(
                  'auto.components.dictation.DictationController.retryRecoveryAudio',
                  'Retry transcription'
                ),
                onClick: () =>
                  void retryRecoveredAudioDictation({
                    chunks: recoveryAudioChunks,
                    target: recoveryTarget,
                    settings,
                    dictationRunRef,
                    activeSessionIdRef,
                    insertionTargetRef,
                    finalTranscriptReceivedRef,
                    insertedFinalTranscriptRef,
                    partialTranscriptRef,
                    dictationStateRef,
                    stoppedSessionIdsRef,
                    stoppedResolversRef,
                    setDictationState,
                    setPartialTranscript
                  })
              }
            : undefined
      toast.error(
        translate(
          'auto.components.dictation.DictationController.de136f1199',
          'Speech error: {{value0}}',
          {
            value0: data.error
          }
        ),
        recoveryAction ? { action: recoveryAction } : undefined
      )
      setDictationNotice({
        kind: 'error',
        message: recoveryAction
          ? translate(
              'auto.components.dictation.DictationController.recoveryAvailable',
              'Dictation failed. Recovery is available.'
            )
          : translate('auto.components.dictation.DictationController.46ced0a32b', 'Speech error.'),
        createdAt: Date.now()
      })
      dictationStateRef.current = 'stopping'
      setDictationState('stopping')
      stopCapture()
      clearRecoveryAudio()
      void (async () => {
        await window.api.speech.stopDictation(sessionId).catch(() => undefined)
        await waitForStoppedSession(sessionId, stoppedSessionIdsRef, stoppedResolversRef)
        await restoreDictationOutput(sessionId)
        if (activeSessionIdRef.current !== null) {
          return
        }
        insertionTargetRef.current = null
        intentionalTargetCancellationRef.current = false
        stopRequestedDuringStartRef.current = false
        finalTranscriptReceivedRef.current = false
        insertedFinalTranscriptRef.current = ''
        partialTranscriptRef.current = ''
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
    settings,
    dictationRunRef,
    activeSessionIdRef,
    insertionTargetRef,
    stoppedSessionIdsRef,
    stoppedResolversRef,
    stopRequestedDuringStartRef,
    finalTranscriptReceivedRef,
    erroredSessionIdsRef,
    intentionalTargetCancellationRef,
    insertedFinalTranscriptRef,
    partialTranscriptRef,
    dictationStateRef,
    setPartialTranscript,
    setDictationState,
    stopCapture,
    getRecoveryAudioChunks,
    clearRecoveryAudio,
    restoreDictationOutput,
    setDictationNotice
  ])
}
