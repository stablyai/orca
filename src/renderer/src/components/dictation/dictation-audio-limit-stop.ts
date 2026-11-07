import type { RefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** The host keeps what was said up to its cap, so stop normally to transcribe and insert it. */
export function stopDictationAtAudioLimit(
  dictationRunRef: RefObject<number>,
  runId: number,
  stopDictationRef: RefObject<(() => void) | null>
): void {
  if (dictationRunRef.current !== runId) {
    return
  }
  toast.message(
    translate(
      'auto.components.dictation.DictationController.cloudLimitReached',
      'Dictation stopped at the 10-minute cloud limit.'
    )
  )
  stopDictationRef.current?.()
}
