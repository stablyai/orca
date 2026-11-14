import { useCallback, type RefObject } from 'react'
import type {
  DictationSession,
  DictationSessionEvent
} from '../../../../shared/dictation-session-machine'
import {
  canRetryDictation,
  transcribeKeptRecording,
  type DictationKeptRecording
} from './dictation-kept-recording'
import {
  dictationStartFailureKind,
  showDictationStartErrorToast,
  type DictationFailureKind
} from './dictation-toasts'
import { shouldHoldForCleanup } from './use-dictation-cleanup'

/** Sends the failed session's recording through the speech host again, into the same place. */
export function useDictationRetry({
  modelId,
  sessionRef,
  keptRef,
  deliverRef,
  dispatch,
  finish,
  showFailure
}: {
  modelId: string | undefined
  sessionRef: RefObject<DictationSession>
  keptRef: RefObject<DictationKeptRecording | null>
  deliverRef: RefObject<((text: string) => void) | null>
  dispatch: (event: DictationSessionEvent) => DictationSession
  finish: (session: DictationSession, beforeEnd: () => void) => Promise<void>
  showFailure: (kind: DictationFailureKind | null, showToast: () => void) => void
}): () => Promise<void> {
  return useCallback(async () => {
    const kept = keptRef.current
    if (sessionRef.current.phase !== 'error' || !modelId || !kept || !canRetryDictation(kept)) {
      return
    }
    const { run, sessionId } = dispatch({ type: 'retry' })
    if (sessionId === null) {
      return
    }
    // The failure landed what was held as heard; what the retry adds waits for cleanup again.
    if (shouldHoldForCleanup()) {
      kept.deliver.hold()
    }
    await transcribeKeptRecording({
      recording: kept,
      modelId,
      sessionId,
      isCurrent: () => sessionRef.current.run === run,
      routeFinals: (sink) => {
        deliverRef.current = sink
      },
      finish: (beforeEnd) => finish(sessionRef.current, beforeEnd),
      fail: (message) =>
        showFailure(dictationStartFailureKind(message) ?? 'transcribe', () =>
          showDictationStartErrorToast(message)
        )
    })
  }, [modelId, sessionRef, keptRef, deliverRef, dispatch, finish, showFailure])
}
