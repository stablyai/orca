import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { captureInsertionTarget } from './dictation-insertion-target'
import { dictationPillAnchorFor, type DictationPillAnchor } from './dictation-pill-anchor'
import { checkSpeechModelUpdate, isSpeechModelKnownReady } from './speech-model-update-check'
import type { SpeechModelUpdateTarget } from './speech-model-update-target'

type CheckedVoice = Pick<VoiceSettings, 'enabled' | 'sttModel'>

const PREFETCH_DELAY_MS = 1500

/** The pill's offer of the download the selected model needs, made in place of recording. */
export function useDictationSpeechModelSetup(
  voice: CheckedVoice | undefined,
  isIdle: () => boolean,
  setPillAnchor: (anchor: DictationPillAnchor | null) => void
) {
  const [setupTarget, setSetupTarget] = useState<SpeechModelUpdateTarget | null>(null)
  // The press whose model check is still running; a stop, cancel, toggle or teardown drops it.
  const pendingStartRef = useRef<number | null>(null)
  const startRequestRef = useRef(0)

  const closeSetup = useCallback(() => {
    setSetupTarget(null)
    if (isIdle()) {
      setPillAnchor(null)
    }
  }, [isIdle, setPillAnchor])

  const hasPendingStart = useCallback(() => pendingStartRef.current !== null, [])

  const invalidatePendingStart = useCallback(() => {
    startRequestRef.current += 1
    pendingStartRef.current = null
  }, [])

  // An unmounted controller (voice turned off) must never open the mic from a check it started.
  useEffect(() => invalidatePendingStart, [invalidatePendingStart])

  // Warms the check off the startup path, so the first press records without waiting on main.
  const enabled = voice?.enabled === true
  const sttModel = voice?.sttModel
  useEffect(() => {
    if (!enabled || !sttModel || isSpeechModelKnownReady({ enabled, sttModel })) {
      return
    }
    const timer = window.setTimeout(
      () => void checkSpeechModelUpdate({ enabled, sttModel }),
      PREFETCH_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [enabled, sttModel])

  /** Checked before the mic opens, so a model the engine can't load never records; true to go on. */
  const readyToRecord = useCallback(
    async (requested: CheckedVoice): Promise<boolean> => {
      if (isSpeechModelKnownReady(requested)) {
        setSetupTarget(null)
        return true
      }
      const request = ++startRequestRef.current
      pendingStartRef.current = request
      const target = await checkSpeechModelUpdate(requested)
      if (request !== startRequestRef.current) {
        return false
      }
      pendingStartRef.current = null
      // Settings may have turned voice off or switched models while the check ran.
      const current = useAppStore.getState().settings?.voice
      if (!current?.enabled || current.sttModel !== requested.sttModel) {
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

  return { setupTarget, closeSetup, hasPendingStart, invalidatePendingStart, readyToRecord }
}
