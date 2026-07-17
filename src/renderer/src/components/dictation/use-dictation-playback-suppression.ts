import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type PlaybackSuppressionOutcome = 'active' | 'canceled' | 'unavailable'

export function useDictationPlaybackSuppression(): {
  acquirePlaybackSuppression: (sessionId: string) => Promise<PlaybackSuppressionOutcome>
  releasePlaybackSuppression: (sessionId: string) => Promise<void>
} {
  const sessionIdsRef = useRef(new Set<string>())
  const warningShownRef = useRef(false)
  const restoreWarningShownRef = useRef(false)

  const acquirePlaybackSuppression = useCallback(
    async (sessionId: string): Promise<PlaybackSuppressionOutcome> => {
      sessionIdsRef.current.add(sessionId)
      const result = await window.api.speech
        .acquirePlaybackSuppression(sessionId)
        .catch(() => ({ active: false as const, reason: 'unavailable' as const }))
      if (result.active) {
        return 'active'
      }

      sessionIdsRef.current.delete(sessionId)
      if (result.reason === 'unavailable' && !warningShownRef.current) {
        warningShownRef.current = true
        toast.message(
          translate(
            'auto.components.dictation.DictationController.c97ad62022',
            'Could not mute other audio. Dictation will continue.'
          )
        )
      }
      return result.reason
    },
    []
  )

  const releasePlaybackSuppression = useCallback(async (sessionId: string): Promise<void> => {
    if (!sessionIdsRef.current.delete(sessionId)) {
      return
    }
    try {
      await window.api.speech.releasePlaybackSuppression(sessionId)
    } catch {
      if (!restoreWarningShownRef.current) {
        restoreWarningShownRef.current = true
        toast.error(
          translate(
            'auto.components.dictation.DictationController.0080b89cf5',
            'Could not restore other audio. Unmute it in system controls.'
          )
        )
      }
    }
  }, [])

  useEffect(() => {
    const sessionIds = sessionIdsRef.current
    return () => {
      for (const sessionId of sessionIds) {
        void window.api.speech.releasePlaybackSuppression(sessionId).catch(() => undefined)
      }
      sessionIds.clear()
    }
  }, [])

  return { acquirePlaybackSuppression, releasePlaybackSuppression }
}
