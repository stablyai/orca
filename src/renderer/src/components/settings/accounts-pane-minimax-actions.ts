import type { Dispatch, SetStateAction } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type MiniMaxCredentialActionContext = {
  miniMaxApiKeyDraft: string
  setMiniMaxApiKeyDraft: Dispatch<SetStateAction<string>>
  setMiniMaxApiKeyConfigured: Dispatch<SetStateAction<boolean>>
  miniMaxCookieDraft: string
  setMiniMaxCookieDraft: Dispatch<SetStateAction<string>>
  setMiniMaxConfigured: Dispatch<SetStateAction<boolean>>
  setMiniMaxCredentialBusy: Dispatch<SetStateAction<boolean>>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createMiniMaxCredentialActions(context: MiniMaxCredentialActionContext): {
  saveMiniMaxApiKey: () => Promise<void>
  clearMiniMaxApiKey: () => Promise<void>
  saveMiniMaxCookie: () => Promise<void>
  clearMiniMaxCookie: () => Promise<void>
} {
  const {
    miniMaxApiKeyDraft,
    setMiniMaxApiKeyDraft,
    setMiniMaxApiKeyConfigured,
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
      if (!status.cookieConfigured) {
        throw new Error(
          translate(
            'auto.components.settings.AccountsPane.8e6f0cb1d8',
            'MiniMax cookie was not saved.'
          )
        )
      }
      setMiniMaxConfigured(status.cookieConfigured)
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
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setMiniMaxCredentialBusy(false)
    }
  }

  const clearMiniMaxCookie = async (): Promise<void> => {
    setMiniMaxCredentialBusy(true)
    try {
      const status = await window.api.minimaxCredentials.clearCookie()
      setMiniMaxConfigured(status.cookieConfigured)
      setMiniMaxCookieDraft('')
      recordFeatureInteraction('usage-tracking')
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.b43e761fe5',
          'MiniMax cookie update failed.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setMiniMaxCredentialBusy(false)
    }
  }

  const saveMiniMaxApiKey = async (): Promise<void> => {
    if (!miniMaxApiKeyDraft.trim()) {
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.d6f1b9b6a2',
          'MiniMax API key is required.'
        )
      )
      return
    }
    setMiniMaxCredentialBusy(true)
    try {
      const status = await window.api.minimaxCredentials.saveApiKey(miniMaxApiKeyDraft.trim())
      if (!status.apiKeyConfigured) {
        throw new Error(
          translate(
            'auto.components.settings.AccountsPane.7c5d8a4e1b',
            'MiniMax API key was not saved.'
          )
        )
      }
      setMiniMaxApiKeyConfigured(status.apiKeyConfigured)
      setMiniMaxApiKeyDraft('')
      recordFeatureInteraction('usage-tracking')
      toast.success(
        translate('auto.components.settings.AccountsPane.4d2c7b9e83', 'MiniMax API key saved.')
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.b43e761fe5',
          'MiniMax credential update failed.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setMiniMaxCredentialBusy(false)
    }
  }

  const clearMiniMaxApiKey = async (): Promise<void> => {
    setMiniMaxCredentialBusy(true)
    try {
      const status = await window.api.minimaxCredentials.clearApiKey()
      setMiniMaxApiKeyConfigured(status.apiKeyConfigured)
      setMiniMaxApiKeyDraft('')
      recordFeatureInteraction('usage-tracking')
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.b43e761fe5',
          'MiniMax credential update failed.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setMiniMaxCredentialBusy(false)
    }
  }

  return { saveMiniMaxCookie, clearMiniMaxCookie, saveMiniMaxApiKey, clearMiniMaxApiKey }
}
