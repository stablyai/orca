import type { MutableRefObject } from 'react'
import { toast } from 'sonner'
import type { DictationState } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import type { DictationInsertionTarget } from './dictation-insertion-target'
import { waitForStoppedSession } from './dictation-stopped-sessions'
import type { DictationRecoveryAudioChunk } from './dictation-recovery'

type RetryRecoveredAudioArgs = {
  chunks: DictationRecoveryAudioChunk[]
  target: DictationInsertionTarget | null
  settings: GlobalSettings | null
  dictationRunRef: MutableRefObject<number>
  activeSessionIdRef: MutableRefObject<string | null>
  insertionTargetRef: MutableRefObject<DictationInsertionTarget | null>
  finalTranscriptReceivedRef: MutableRefObject<boolean>
  insertedFinalTranscriptRef: MutableRefObject<string>
  partialTranscriptRef: MutableRefObject<string>
  dictationStateRef: MutableRefObject<DictationState>
  stoppedSessionIdsRef: MutableRefObject<Set<string>>
  stoppedResolversRef: MutableRefObject<Map<string, () => void>>
  setDictationState: (state: DictationState) => void
  setPartialTranscript: (text: string) => void
}

export async function retryRecoveredAudioDictation({
  chunks,
  target,
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
}: RetryRecoveredAudioArgs): Promise<void> {
  const modelId = settings?.voice?.sttModel
  if (!modelId || chunks.length === 0) {
    return
  }
  const retrySessionId = `recovery-${Date.now()}`
  const customVocabulary = settings?.voice?.customVocabulary
  const hotwords = customVocabulary && customVocabulary.length > 0 ? customVocabulary : undefined
  dictationRunRef.current += 1
  activeSessionIdRef.current = retrySessionId
  insertionTargetRef.current = target
  finalTranscriptReceivedRef.current = false
  insertedFinalTranscriptRef.current = ''
  partialTranscriptRef.current = ''
  dictationStateRef.current = 'starting'
  setDictationState('starting')
  setPartialTranscript('')
  try {
    await window.api.speech.startDictation(modelId, hotwords, retrySessionId)
    for (const chunk of chunks) {
      await window.api.speech.feedAudio(chunk.samples, chunk.sampleRate, retrySessionId)
    }
    dictationStateRef.current = 'stopping'
    setDictationState('stopping')
    await window.api.speech.stopDictation(retrySessionId)
    await waitForStoppedSession(retrySessionId, stoppedSessionIdsRef, stoppedResolversRef)
  } catch (err) {
    toast.error(
      translate(
        'auto.components.dictation.DictationController.recoveryRetryFailed',
        'Could not retry dictation: {{value0}}',
        { value0: String(err) }
      )
    )
  } finally {
    if (activeSessionIdRef.current === retrySessionId) {
      activeSessionIdRef.current = null
    }
    insertionTargetRef.current = null
    finalTranscriptReceivedRef.current = false
    insertedFinalTranscriptRef.current = ''
    partialTranscriptRef.current = ''
    dictationStateRef.current = 'idle'
    setDictationState('idle')
    setPartialTranscript('')
  }
}
