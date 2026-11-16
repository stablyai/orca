import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { observedProviderAccounts } from '@/runtime/provider-accounts/observations/observed-provider-accounts'
import { fetchProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentSessionHeldDelivery } from '../../../../../shared/agent-session/agent-session-held-delivery'

const noSubscribe = () => () => {}
const noSnapshot = () => null

/** A successful login newer than this failure clears stale sign-in presentation, not the queue hold. */
export function useWorkerSignInRecovery(
  delivery: AgentSessionHeldDelivery,
  target?: RuntimeClientTarget
): boolean {
  const settings = useAppStore((state) => state.settings)
  const provider =
    delivery.provider === 'claude' || delivery.provider === 'codex' ? delivery.provider : null
  const source = useMemo(
    () =>
      target && provider && delivery.reason.failure === 'sign-in'
        ? observedProviderAccounts(target, provider)
        : null,
    [target, provider, delivery.reason.failure]
  )
  const answer = useSyncExternalStore(
    source?.subscribe ?? noSubscribe,
    source?.getSnapshot ?? noSnapshot,
    noSnapshot
  )
  useEffect(() => {
    if (!source || !target || target.kind !== 'local' || !provider) {
      return
    }
    let current = true
    void fetchProviderAccountsSnapshot(target)
      .then((snapshot) => {
        if (current && !snapshot.failedProviders?.includes(provider)) {
          source.setAccounts(snapshot[provider])
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [source, target, provider, settings])
  const account = answer?.accounts?.accounts.find(
    (row) => row.id === answer.accounts?.activeAccountId
  )
  return !!(
    answer?.known &&
    delivery.failedAtTime &&
    account &&
    account.lastAuthenticatedAt > delivery.failedAtTime
  )
}
