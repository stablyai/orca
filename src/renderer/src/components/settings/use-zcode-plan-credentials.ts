import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import type { ZcodePlanCredentialsStatus } from '../../../../shared/zcode-plan-sites'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  callZcodePlanCredentials,
  UsageCredentialsHostOutdatedError
} from '@/runtime/runtime-usage-credentials-client'
import {
  usageCredentialAccessAfterError,
  type UsageCredentialAccess
} from './usage-credential-host'

const LOCAL_OWNER: RuntimeClientTarget = { kind: 'local' }

/** Key by owner so switching GLM credential hosts resets drafts. */
export function useZcodePlanCredentials(
  updatedAt: number | undefined,
  owner: RuntimeClientTarget = LOCAL_OWNER
) {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [status, setStatus] = useState<ZcodePlanCredentialsStatus | null>(null)
  const [access, setAccess] = useState<UsageCredentialAccess>(
    owner.kind === 'local' ? 'ready' : 'checking'
  )
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [credentialBusy, setCredentialBusy] = useState(false)
  const readGeneration = useRef(0)
  const mutationPending = useRef(false)

  const ownerEnvironmentId = owner.kind === 'environment' ? owner.environmentId : null

  useEffect(() => {
    if (mutationPending.current) {
      return
    }
    const request = ++readGeneration.current
    const readTarget: RuntimeClientTarget = ownerEnvironmentId
      ? { kind: 'environment', environmentId: ownerEnvironmentId }
      : LOCAL_OWNER
    void callZcodePlanCredentials(readTarget, 'getStatus').then(
      (next) => {
        if (request === readGeneration.current) {
          setStatus(next)
          setAccess('ready')
        }
      },
      (error: unknown) => {
        if (request === readGeneration.current) {
          setStatus(null)
          // Local storage stays writable even when its status read fails.
          setAccess(ownerEnvironmentId ? usageCredentialAccessAfterError(error) : 'ready')
        }
      }
    )
    return () => {
      readGeneration.current += 1
    }
  }, [updatedAt, credentialBusy, ownerEnvironmentId])

  const updateCredential = async (action: 'save' | 'clear'): Promise<void> => {
    if (mutationPending.current) {
      return
    }
    readGeneration.current += 1
    mutationPending.current = true
    setCredentialBusy(true)
    try {
      const next =
        action === 'save'
          ? await callZcodePlanCredentials(owner, 'saveApiKey', apiKeyDraft.trim())
          : await callZcodePlanCredentials(owner, 'clearApiKey')
      if (
        !next ||
        typeof next.apiKeyConfigured !== 'boolean' ||
        typeof next.zcodeCliConfigured !== 'boolean'
      ) {
        throw new Error(
          'GLM Coding Plan keys can only be changed in the desktop app on the computer running Orca.'
        )
      }
      setStatus(next)
      setApiKeyDraft('')
      recordFeatureInteraction('usage-tracking')
      if (action === 'save') {
        toast.success(
          translate(
            'auto.components.settings.ZcodePlanAccountsSection.keySaved',
            'GLM Coding Plan API key saved.'
          )
        )
      }
    } catch (error) {
      if (error instanceof UsageCredentialsHostOutdatedError) {
        setAccess('outdated')
      }
      toast.error(
        translate(
          'auto.components.settings.ZcodePlanAccountsSection.keySaveFailed',
          'GLM Coding Plan credential update failed.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      mutationPending.current = false
      setCredentialBusy(false)
    }
  }

  return {
    status,
    access,
    apiKeyDraft,
    setApiKeyDraft,
    credentialBusy,
    saveApiKey: () => updateCredential('save'),
    clearApiKey: () => updateCredential('clear')
  }
}
