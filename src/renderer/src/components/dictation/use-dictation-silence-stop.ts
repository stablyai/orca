import { useEffect, useEffectEvent } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { watchDictationSilence } from '../../../../shared/dictation-silence-stop'

// A forgotten toggle mic stays open; a held push-to-talk key or button ends the session on release.
export function useDictationSilenceStop(
  watching: boolean,
  getLastSpeechAt: () => number,
  stopDictation: () => void
): void {
  const stopForSilence = useEffectEvent(() => {
    toast.message(
      translate(
        'auto.components.dictation.DictationController.stoppedAfterSilence',
        'Stopped after a minute of silence'
      )
    )
    stopDictation()
  })

  useEffect(() => {
    if (!watching) {
      return
    }
    return watchDictationSilence(
      getLastSpeechAt,
      () => performance.now(),
      () => stopForSilence()
    )
  }, [watching, getLastSpeechAt])
}
