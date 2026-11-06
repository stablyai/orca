import { useEffect, useEffectEvent, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { watchDictationSilence } from '../../../../shared/dictation-silence-stop'

// A forgotten toggle mic stays open; a held push-to-talk key is never forgotten, and its release stops it.
export function useDictationSilenceStop(
  listening: boolean,
  holdGestureActiveRef: MutableRefObject<boolean>,
  getLastSpeechAt: () => number,
  stopDictation: () => void
): void {
  const stopForSilence = useEffectEvent(() => {
    if (holdGestureActiveRef.current) {
      return
    }
    toast.message(
      translate(
        'auto.components.dictation.DictationController.stoppedAfterSilence',
        'Stopped after a minute of silence'
      )
    )
    stopDictation()
  })

  useEffect(() => {
    if (!listening) {
      return
    }
    return watchDictationSilence(
      getLastSpeechAt,
      () => performance.now(),
      () => stopForSilence()
    )
  }, [listening, getLastSpeechAt])
}
