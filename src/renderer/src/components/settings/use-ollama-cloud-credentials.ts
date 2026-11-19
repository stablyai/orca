import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../store'
import type { OllamaCloudCredentialsStatus } from '../../../../shared/ollama-cloud'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  callOllamaCloudCredentials,
  UsageCredentialsHostOutdatedError
} from '@/runtime/provider-accounts/usage/runtime-usage-credentials-client'
import {
  usageCredentialAccessAfterError,
  type UsageCredentialAccess
} from './accounts/usage/usage-credential-host'

const LOCAL_OWNER: RuntimeClientTarget = { kind: 'local' }

async function runCredentialMutation(
  mutate: () => Promise<OllamaCloudCredentialsStatus>,
  onSuccess: (status: OllamaCloudCredentialsStatus) => void,
  onError: (error: unknown) => void,
  onFinally: () => void
): Promise<void> {
  try {
    const next = await mutate()
    if (!next || typeof next.apiKeyConfigured !== 'boolean') {
      throw new Error(
        'Ollama cloud credentials can only be changed in the desktop app on the computer running Orca.'
      )
    }
    onSuccess(next)
  } catch (error) {
    onError(error)
  } finally {
    onFinally()
  }
}

/** Key by owner so switching Ollama credential hosts resets drafts. */
export function useOllamaCloudCredentials(
  updatedAt: number | undefined,
  owner: RuntimeClientTarget = LOCAL_OWNER
) {
  const t = useTranslate()
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [status, setStatus] = useState<OllamaCloudCredentialsStatus | null>(null)
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
    void callOllamaCloudCredentials(readTarget, 'getStatus').then(
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
    const mutate = () =>
      action === 'save'
        ? callOllamaCloudCredentials(owner, 'saveApiKey', apiKeyDraft.trim())
        : callOllamaCloudCredentials(owner, 'clearApiKey')
    await runCredentialMutation(
      mutate,
      (next) => {
        setStatus(next)
        setApiKeyDraft('')
        recordFeatureInteraction('usage-tracking')
        if (action === 'save') {
          toast.success(
            t(
              'auto.components.settings.OllamaCloudAccountsSection.keySaved',
              'Ollama cloud API key saved.'
            )
          )
        }
      },
      (error) => {
        if (error instanceof UsageCredentialsHostOutdatedError) {
          setAccess('outdated')
        }
        toast.error(
          t(
            'auto.components.settings.OllamaCloudAccountsSection.keySaveFailed',
            'Ollama cloud credential update failed.'
          ),
          { description: error instanceof Error ? error.message : String(error) }
        )
      },
      () => {
        mutationPending.current = false
        setCredentialBusy(false)
      }
    )
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
