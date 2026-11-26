import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../../../store/index'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { UsageCredentialsHostOutdatedError } from '@/runtime/provider-accounts/usage/runtime-usage-credentials-client'
import {
  usageCredentialAccessAfterError,
  type UsageCredentialAccess
} from './usage-credential-host'

const LOCAL_OWNER: RuntimeClientTarget = { kind: 'local' }

type UsageApiKeyAction = 'getStatus' | 'saveApiKey' | 'clearApiKey'
type UsageApiKeyMutation = 'saveApiKey' | 'clearApiKey'

type UsageApiKeyCredentialsConfig<S extends { apiKeyConfigured: boolean }> = {
  owner: RuntimeClientTarget
  /** A fresh usage reading re-reads the credential status. */
  updatedAt: number | undefined
  /** Must be a stable module-level function: it is an effect dependency. */
  call: (owner: RuntimeClientTarget, action: UsageApiKeyAction, value?: string) => Promise<S>
  /** Hosts that cannot store keys answer with something other than a status. */
  isStatus: (next: S | null | undefined) => next is S
  hostCannotStoreMessage: string
  onMutated?: (action: UsageApiKeyMutation) => void
  onMutationFailed: (action: UsageApiKeyMutation, error: Error) => void
}

/** One API key credential on the selected host; key the caller by owner so switching hosts resets drafts. */
export function useUsageApiKeyCredentials<S extends { apiKeyConfigured: boolean }>({
  owner,
  updatedAt,
  call,
  isStatus,
  hostCannotStoreMessage,
  onMutated,
  onMutationFailed
}: UsageApiKeyCredentialsConfig<S>) {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [status, setStatus] = useState<S | null>(null)
  const [access, setAccess] = useState<UsageCredentialAccess>(
    owner.kind === 'local' ? 'ready' : 'checking'
  )
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
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
    void call(readTarget, 'getStatus').then(
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
  }, [call, updatedAt, busy, ownerEnvironmentId, retryNonce])

  const retry = (): void => {
    if (busy) {
      return
    }
    setAccess('checking')
    setRetryNonce((nonce) => nonce + 1)
  }

  const mutate = async (action: UsageApiKeyMutation): Promise<void> => {
    if (mutationPending.current) {
      return
    }
    readGeneration.current += 1
    mutationPending.current = true
    setBusy(true)
    try {
      const next = await call(owner, action, action === 'saveApiKey' ? draft.trim() : '')
      if (!isStatus(next)) {
        throw new Error(hostCannotStoreMessage)
      }
      setStatus(next)
      setDraft('')
      recordFeatureInteraction('usage-tracking')
      onMutated?.(action)
    } catch (error) {
      if (error instanceof UsageCredentialsHostOutdatedError) {
        setAccess('outdated')
      }
      onMutationFailed(action, error instanceof Error ? error : new Error(String(error)))
    } finally {
      mutationPending.current = false
      setBusy(false)
    }
  }

  return {
    status,
    access,
    draft,
    setDraft,
    busy,
    retry,
    saveApiKey: () => mutate('saveApiKey'),
    clearApiKey: () => mutate('clearApiKey')
  }
}
