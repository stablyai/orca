import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { SpeechModelUpdateTarget } from './speech-model-update-target'

export type SpeechModelUpdatePhase = 'notice' | 'downloading' | 'done' | 'failed'

export type SpeechModelUpdateDownload = {
  phase: SpeechModelUpdatePhase
  percent: number
  doneMb: number
  totalMb: number
  deleting: boolean
  start: () => void
  cancel: () => void
  deleteRetired: () => void
}

/** Downloads the model the speech engine needs; follows the shared model states, as Settings can start it too. */
export function useSpeechModelUpdateDownload(
  { model, retired }: SpeechModelUpdateTarget,
  onClose: () => void
): SpeechModelUpdateDownload {
  const t = useTranslate()
  const state = useAppStore((s) => s.modelStates.find((m) => m.id === model.id))
  const refreshModelStates = useAppStore((s) => s.refreshModelStates)
  const [failed, setFailed] = useState(false)
  // Set from the click, so ✕ cancels a download whose first progress hasn't arrived yet.
  const [inFlight, setInFlight] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(
    () => window.api.speech.onDownloadProgress(() => void refreshModelStates()),
    [refreshModelStates]
  )

  const totalMb = Math.round((model.sizeBytes ?? 0) / 1_000_000)
  const progress = state?.progress ?? 0
  const downloading =
    state?.status === 'downloading' ||
    state?.status === 'extracting' ||
    (inFlight && state?.status !== 'ready')
  const phase: SpeechModelUpdatePhase = downloading
    ? 'downloading'
    : state?.status === 'ready'
      ? 'done'
      : failed
        ? 'failed'
        : 'notice'

  const start = (): void => {
    setFailed(false)
    setInFlight(true)
    void window.api.speech
      .downloadModel(model.id)
      .catch(() => setFailed(true))
      .finally(() => {
        setInFlight(false)
        void refreshModelStates()
      })
  }

  const cancel = (): void => {
    void window.api.speech
      .cancelDownload(model.id)
      .catch(() => undefined)
      .finally(() => void refreshModelStates())
  }

  const deleteRetired = (): void => {
    if (!retired) {
      return
    }
    setDeleting(true)
    void window.api.speech
      .deleteModel(retired.id)
      .then(() => {
        void refreshModelStates()
        onClose()
      })
      .catch(() => {
        setDeleting(false)
        toast.error(
          t('speechModelUpdate.pill.deleteFailed', 'Failed to delete {{model}}.', {
            model: retired.label
          })
        )
      })
  }

  return {
    phase,
    percent: Math.round(progress * 100),
    doneMb: Math.round(progress * totalMb),
    totalMb,
    deleting,
    start,
    cancel,
    deleteRetired
  }
}
