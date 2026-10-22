import { useEffect, useState } from 'react'
import { useAppStore } from '../../store'
import type { MiniMaxCredentialsStatus } from '../../../../shared/minimax-credentials-status'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callMiniMaxCredentials } from '@/runtime/runtime-usage-credentials-client'
import { createMiniMaxCredentialActions } from './accounts-pane-minimax-actions'
import {
  usageCredentialAccessAfterError,
  type UsageCredentialAccess
} from './usage-credential-host'

export type MiniMaxCredentialsModel = ReturnType<typeof useMiniMaxCredentials>

/** MiniMax's saved cookie and API key on `owner`; key the component by owner so drafts reset. */
export function useMiniMaxCredentials(owner: RuntimeClientTarget) {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [status, setStatus] = useState<MiniMaxCredentialsStatus | null>(null)
  const [access, setAccess] = useState<UsageCredentialAccess>(
    owner.kind === 'local' ? 'ready' : 'checking'
  )
  const [miniMaxCookieDraft, setMiniMaxCookieDraft] = useState('')
  const [miniMaxApiKeyDraft, setMiniMaxApiKeyDraft] = useState('')
  const [miniMaxCredentialBusy, setMiniMaxCredentialBusy] = useState(false)

  const ownerEnvironmentId = owner.kind === 'environment' ? owner.environmentId : null
  useEffect(() => {
    let current = true
    const target: RuntimeClientTarget = ownerEnvironmentId
      ? { kind: 'environment', environmentId: ownerEnvironmentId }
      : { kind: 'local' }
    void callMiniMaxCredentials(target, 'getStatus').then(
      (next) => {
        if (current) {
          setStatus(next)
          setAccess('ready')
        }
      },
      (error: unknown) => {
        console.error('Failed to load MiniMax credential status:', error)
        if (current) {
          // Why local stays editable: this computer's store is always writable, as before.
          setAccess(ownerEnvironmentId ? usageCredentialAccessAfterError(error) : 'ready')
        }
      }
    )
    return () => {
      current = false
    }
  }, [ownerEnvironmentId])

  const actions = createMiniMaxCredentialActions({
    owner,
    miniMaxApiKeyDraft,
    setMiniMaxApiKeyDraft,
    miniMaxCookieDraft,
    setMiniMaxCookieDraft,
    setStatus,
    setAccess,
    setMiniMaxCredentialBusy,
    recordFeatureInteraction
  })

  return {
    access,
    // Why: only a host that answered can be written; never fall back to this computer.
    editable: access === 'ready',
    miniMaxConfigured: status?.cookieConfigured === true,
    miniMaxCookieProtection: status?.cookieProtection ?? null,
    miniMaxApiKeyConfigured: status?.apiKeyConfigured === true,
    miniMaxApiKeyProtection: status?.apiKeyProtection ?? null,
    // Why `!== false`: older hosts and this desktop omit or set it; only orcad says it cannot.
    sessionCookieSupported: status?.sessionCookieSupported !== false,
    miniMaxCookieUnreadable: status?.cookieUnreadable,
    miniMaxApiKeyUnreadable: status?.apiKeyUnreadable,
    miniMaxCookieDraft,
    setMiniMaxCookieDraft,
    miniMaxApiKeyDraft,
    setMiniMaxApiKeyDraft,
    miniMaxCredentialBusy,
    ...actions
  }
}
