import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  fetchProviderAccountsSnapshot,
  getProviderAccountsOwnerKey,
  type ProviderAccountsSnapshot
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { observedProviderAccounts } from '@/runtime/provider-accounts/observations/observed-provider-accounts'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const noSubscription = () => () => {}
const noSnapshot = () => null

/** The switchers share snapshot loading; a failed provider half never replaces its roster. */
export function useProviderAccountList<Provider extends 'claude' | 'codex'>(
  provider: Provider,
  target: RuntimeClientTarget,
  syncKey: string,
  initial: ProviderAccountsSnapshot[Provider],
  observe = false,
  enabled = true
) {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const ownerTarget = useMemo<RuntimeClientTarget>(
    () => (environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }),
    [environmentId]
  )
  const ownerKey = `${getProviderAccountsOwnerKey(ownerTarget)}:${provider}`
  const mountedRef = useMemo(() => ({ current: true, ownerKey }), [ownerKey])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [mountedRef])
  const observation = useMemo(
    () => observedProviderAccounts(ownerTarget, provider),
    [ownerTarget, provider]
  )
  const observing = enabled && observe && environmentId !== null
  const answer = useSyncExternalStore(
    observing ? observation.subscribe : noSubscription,
    observing ? observation.getSnapshot : noSnapshot,
    noSnapshot
  )
  const [local, setLocal] = useState({ ownerKey, accounts: initial, known: false })
  const accounts = observing
    ? (answer?.accounts ?? initial)
    : local.ownerKey === ownerKey
      ? local.accounts
      : initial
  const accountsLoaded = observing
    ? (answer?.known ?? false)
    : local.ownerKey === ownerKey && local.known
  const setAccounts = useCallback(
    (next: ProviderAccountsSnapshot[Provider]) => {
      if (!mountedRef.current) {
        return
      }
      if (observing) {
        observation.setAccounts(next)
      } else {
        setLocal((previous) => ({
          ownerKey,
          accounts: next,
          known: previous.ownerKey === ownerKey && previous.known
        }))
      }
    },
    [mountedRef, observing, observation, ownerKey]
  )
  const loadAccounts = useCallback(async () => {
    if (!enabled) {
      return
    }
    const snapshot = await fetchProviderAccountsSnapshot(ownerTarget)
    if (snapshot.failedProviders?.includes(provider)) {
      console.error(`${provider} account list failed; keeping previous state.`)
      return
    }
    if (mountedRef.current) {
      if (observing) {
        observation.setAccounts(snapshot[provider])
      } else {
        setLocal({ ownerKey, accounts: snapshot[provider], known: true })
      }
    }
  }, [provider, ownerTarget, ownerKey, observing, observation, mountedRef, enabled])
  useEffect(() => {
    if (enabled && !observing) {
      void loadAccounts().catch((error: unknown) =>
        console.error(`Failed to load ${provider} accounts:`, error)
      )
    }
  }, [loadAccounts, observing, provider, syncKey, enabled])
  return { accounts, setAccounts, accountsLoaded, loadAccounts, mountedRef }
}
