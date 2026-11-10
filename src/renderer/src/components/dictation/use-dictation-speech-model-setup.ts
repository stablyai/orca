import { useCallback, useRef, useState } from 'react'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { captureInsertionTarget } from './dictation-insertion-target'
import { dictationPillAnchorFor, type DictationPillAnchor } from './dictation-pill-anchor'
import { checkSpeechModelUpdate } from './speech-model-update-check'
import type { SpeechModelUpdateTarget } from './speech-model-update-target'

/** The pill's offer of the download the selected model needs, made in place of recording. */
export function useDictationSpeechModelSetup(
  isIdle: () => boolean,
  setPillAnchor: (anchor: DictationPillAnchor | null) => void
) {
  const [setupTarget, setSetupTarget] = useState<SpeechModelUpdateTarget | null>(null)
  // A stop or cancel while the check runs means that press no longer wants a recording.
  const startRequestRef = useRef(0)

  const closeSetup = useCallback(() => {
    setSetupTarget(null)
    if (isIdle()) {
      setPillAnchor(null)
    }
  }, [isIdle, setPillAnchor])

  const invalidatePendingStart = useCallback(() => {
    startRequestRef.current += 1
  }, [])

  /** Checked before the mic opens, so a model the engine can't load never records; true to go on. */
  const readyToRecord = useCallback(
    async (voice: Pick<VoiceSettings, 'enabled' | 'sttModel'>): Promise<boolean> => {
      const request = ++startRequestRef.current
      const target = await checkSpeechModelUpdate(voice)
      if (request !== startRequestRef.current) {
        return false
      }
      if (target) {
        if (isIdle()) {
          setPillAnchor(dictationPillAnchorFor(captureInsertionTarget()))
          setSetupTarget(target)
        }
        return false
      }
      setSetupTarget(null)
      return true
    },
    [isIdle, setPillAnchor]
  )

  return { setupTarget, closeSetup, invalidatePendingStart, readyToRecord }
}
