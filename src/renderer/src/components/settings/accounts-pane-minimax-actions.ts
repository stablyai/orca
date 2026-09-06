import type { Dispatch, SetStateAction } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type MiniMaxCredentialActionContext = {
  miniMaxCookieDraft: string
  setMiniMaxCookieDraft: Dispatch<SetStateAction<string>>
  setMiniMaxConfigured: Dispatch<SetStateAction<boolean>>
  setMiniMaxCredentialBusy: Dispatch<SetStateAction<boolean>>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createMiniMaxCredentialActions(context: MiniMaxCredentialActionContext): {
  saveMiniMaxCookie: () => Promise<void>
  clearMiniMaxCookie: () => Promise<void>
} {
  const {
    miniMaxCookieDraft,
    setMiniMaxCookieDraft,
    setMiniMaxConfigured,
    setMiniMaxCredentialBusy,
    recordFeatureInteraction
  } = context
  const saveMiniMaxCookie = async (): Promise<void> => {
    if (!miniMaxCookieDraft.trim()) {
      toast.error(
        translate('auto.components.settings.AccountsPane.2f24f244a4', 'MiniMax cookie is required.')
      )
      return
    }
    setMiniMaxCredentialBusy(true)
    try {
      const status = await window.api.minimaxCredentials.saveCookie(miniMaxCookieDraft.trim())
      if (!status.configured) {
        throw new Error(
          translate(
            'auto.components.settings.AccountsPane.8e6f0cb1d8',
            'MiniMax cookie was not saved.'
          )
        )
      }
      setMiniMaxConfigured(status.configured)
      setMiniMaxCookieDraft('')
      recordFeatureInteraction('usage-tracking')
      toast.success(
        translate('auto.components.settings.AccountsPane.8d61637a77', 'MiniMax cookie saved.')
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.b43e761fe5',
          'MiniMax cookie update failed.'
        ),
        { description: String((error as Error)?.message ?? error) }
      )
    } finally {
      setMiniMaxCredentialBusy(false)
    }
  }

  const clearMiniMaxCookie = async (): Promise<void> => {
    setMiniMaxCredentialBusy(true)
    try {
      const status = await window.api.minimaxCredentials.clearCookie()
      setMiniMaxConfigured(status.configured)
      setMiniMaxCookieDraft('')
      recordFeatureInteraction('usage-tracking')
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.b43e761fe5',
          'MiniMax cookie update failed.'
        ),
        { description: String((error as Error)?.message ?? error) }
      )
    } finally {
      setMiniMaxCredentialBusy(false)
    }
  }

  return { saveMiniMaxCookie, clearMiniMaxCookie }
}
