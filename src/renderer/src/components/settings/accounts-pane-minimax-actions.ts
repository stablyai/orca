import type { Dispatch, SetStateAction } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type { MiniMaxCredentialsStatus } from '../../../../shared/minimax-credentials-status'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  callMiniMaxCredentials,
  UsageCredentialsHostOutdatedError,
  type MiniMaxCredentialAction
} from '@/runtime/runtime-usage-credentials-client'
import type { UsageCredentialAccess } from './usage-credential-host'

type MiniMaxCredentialActionContext = {
  owner: RuntimeClientTarget
  miniMaxApiKeyDraft: string
  setMiniMaxApiKeyDraft: Dispatch<SetStateAction<string>>
  miniMaxCookieDraft: string
  setMiniMaxCookieDraft: Dispatch<SetStateAction<string>>
  setStatus: Dispatch<SetStateAction<MiniMaxCredentialsStatus | null>>
  setAccess: Dispatch<SetStateAction<UsageCredentialAccess>>
  setMiniMaxCredentialBusy: Dispatch<SetStateAction<boolean>>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createMiniMaxCredentialActions(context: MiniMaxCredentialActionContext): {
  saveMiniMaxApiKey: () => Promise<void>
  clearMiniMaxApiKey: () => Promise<void>
  saveMiniMaxCookie: () => Promise<void>
  clearMiniMaxCookie: () => Promise<void>
} {
  const { owner, setStatus, setAccess, setMiniMaxCredentialBusy, recordFeatureInteraction } =
    context

  const run = async (
    action: MiniMaxCredentialAction,
    options: {
      value?: string
      clearDraft: () => void
      failureMessage: string
      /** For a save: whether the returned status shows it landed, and what to say when it did. */
      saved?: {
        landed: (status: MiniMaxCredentialsStatus) => boolean
        notSaved: string
        ok: string
      }
    }
  ): Promise<void> => {
    setMiniMaxCredentialBusy(true)
    try {
      const status = await callMiniMaxCredentials(owner, action, options.value)
      if (options.saved && !options.saved.landed(status)) {
        throw new Error(options.saved.notSaved)
      }
      setStatus(status)
      options.clearDraft()
      recordFeatureInteraction('usage-tracking')
      if (options.saved) {
        toast.success(options.saved.ok)
      }
    } catch (error) {
      if (error instanceof UsageCredentialsHostOutdatedError) {
        setAccess('outdated')
      }
      toast.error(options.failureMessage, {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setMiniMaxCredentialBusy(false)
    }
  }

  const clearCookieDraft = (): void => context.setMiniMaxCookieDraft('')
  const clearApiKeyDraft = (): void => context.setMiniMaxApiKeyDraft('')
  const cookieFailure = translate(
    'auto.components.settings.AccountsPane.b43e761fe5',
    'MiniMax cookie update failed.'
  )
  const apiKeyFailure = translate(
    'auto.components.settings.AccountsPane.apiKeyUpdateFailed',
    'MiniMax API key update failed.'
  )

  const saveMiniMaxCookie = async (): Promise<void> => {
    const cookie = context.miniMaxCookieDraft.trim()
    if (!cookie) {
      toast.error(
        translate('auto.components.settings.AccountsPane.2f24f244a4', 'MiniMax cookie is required.')
      )
      return
    }
    await run('saveCookie', {
      value: cookie,
      clearDraft: clearCookieDraft,
      failureMessage: cookieFailure,
      saved: {
        landed: (status) => status.cookieConfigured,
        notSaved: translate(
          'auto.components.settings.AccountsPane.8e6f0cb1d8',
          'MiniMax cookie was not saved.'
        ),
        ok: translate('auto.components.settings.AccountsPane.8d61637a77', 'MiniMax cookie saved.')
      }
    })
  }

  const saveMiniMaxApiKey = async (): Promise<void> => {
    const apiKey = context.miniMaxApiKeyDraft.trim()
    if (!apiKey) {
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.d6f1b9b6a2',
          'MiniMax API key is required.'
        )
      )
      return
    }
    await run('saveApiKey', {
      value: apiKey,
      clearDraft: clearApiKeyDraft,
      failureMessage: apiKeyFailure,
      saved: {
        landed: (status) => status.apiKeyConfigured,
        notSaved: translate(
          'auto.components.settings.AccountsPane.7c5d8a4e1b',
          'MiniMax API key was not saved.'
        ),
        ok: translate('auto.components.settings.AccountsPane.4d2c7b9e83', 'MiniMax API key saved.')
      }
    })
  }

  return {
    saveMiniMaxCookie,
    clearMiniMaxCookie: () =>
      run('clearCookie', { clearDraft: clearCookieDraft, failureMessage: cookieFailure }),
    saveMiniMaxApiKey,
    clearMiniMaxApiKey: () =>
      run('clearApiKey', { clearDraft: clearApiKeyDraft, failureMessage: apiKeyFailure })
  }
}
