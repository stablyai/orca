import { useEffect, useEffectEvent } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  watchDictationSilence,
  type StopAfterSilenceSeconds
} from '../../../../shared/dictation-silence-stop'

// A forgotten toggle mic stays open; a held push-to-talk key or button ends the session on release.
export function useDictationSilenceStop(
  listening: boolean,
  dictationMode: string | undefined,
  silenceSeconds: StopAfterSilenceSeconds,
  getLastSpeechAt: () => number,
  /** A held shortcut counts as speech: Auto mode records until release, however quiet. */
  isHolding: () => boolean,
  stopDictation: () => void
): void {
  const watching = listening && dictationMode !== 'hold' && silenceSeconds !== null
  const stopForSilence = useEffectEvent(() => {
    toast.message(
      translate(
        'components.dictation.stoppedAfterSilenceSeconds',
        'Stopped after {{seconds}} seconds of silence',
        { seconds: silenceSeconds }
      )
    )
    stopDictation()
  })

  useEffect(() => {
    if (!watching || silenceSeconds === null) {
      return
    }
    return watchDictationSilence(
      () => (isHolding() ? performance.now() : getLastSpeechAt()),
      () => performance.now(),
      silenceSeconds * 1000,
      () => stopForSilence()
    )
  }, [watching, silenceSeconds, getLastSpeechAt, isHolding])
}
