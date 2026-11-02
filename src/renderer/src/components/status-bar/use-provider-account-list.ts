import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  fetchProviderAccountsSnapshot,
  getProviderAccountsOwnerKey,
  invalidateProviderAccountsSnapshot,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import { observedProviderAccounts } from '@/runtime/observed-provider-accounts'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const noSubscription = () => () => {}
const noSnapshot = () => null
const accountListRefreshListeners = new Map<string, Set<() => void>>()

export function refreshProviderAccountLists(
  target: RuntimeClientTarget,
  provider: 'claude' | 'codex'
): void {
  invalidateProviderAccountsSnapshot(target)
  accountListRefreshListeners
    .get(`${getProviderAccountsOwnerKey(target)}:${provider}`)
    ?.forEach((refresh) => refresh())
}

/** The switchers share snapshot loading; a failed provider half never replaces its roster. */
export function useProviderAccountList<Provider extends 'claude' | 'codex'>(
  provider: Provider,
  target: RuntimeClientTarget,
  syncKey: string,
  initial: ProviderAccountsSnapshot[Provider],
  observe = false
) {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const ownerTarget = useMemo<RuntimeClientTarget>(
    () => (environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }),
    [environmentId]
  )
  const ownerKey = `${getProviderAccountsOwnerKey(ownerTarget)}:${provider}`
  const mountedRef = useMemo(() => ({ current: true, ownerKey, requestVersion: 0 }), [ownerKey])
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
  const observing = observe && environmentId !== null
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
      mountedRef.requestVersion += 1
      invalidateProviderAccountsSnapshot(ownerTarget)
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
    [mountedRef, observing, observation, ownerKey, ownerTarget]
  )
  const loadAccounts = useCallback(async () => {
    if (!mountedRef.current) {
      return
    }
    const requestVersion = ++mountedRef.requestVersion
    const snapshot = await fetchProviderAccountsSnapshot(ownerTarget)
    if (!mountedRef.current || mountedRef.requestVersion !== requestVersion) {
      return
    }
    if (snapshot.failedProviders?.includes(provider)) {
      console.error(`${provider} account list failed; keeping previous state.`)
      return
    }
    if (observing) {
      observation.setAccounts(snapshot[provider])
    } else {
      setLocal({ ownerKey, accounts: snapshot[provider], known: true })
    }
  }, [provider, ownerTarget, ownerKey, observing, observation, mountedRef])
  useEffect(() => {
    if (!observing) {
      void loadAccounts().catch((error: unknown) =>
        console.error(`Failed to load ${provider} accounts:`, error)
      )
    }
  }, [loadAccounts, observing, provider, syncKey])
  useEffect(() => {
    const refresh = () => {
      void loadAccounts().catch((error: unknown) =>
        console.error(`Failed to load ${provider} accounts:`, error)
      )
    }
    const listeners = accountListRefreshListeners.get(ownerKey) ?? new Set()
    listeners.add(refresh)
    accountListRefreshListeners.set(ownerKey, listeners)
    return () => {
      listeners.delete(refresh)
      if (listeners.size === 0) {
        accountListRefreshListeners.delete(ownerKey)
      }
    }
  }, [loadAccounts, ownerKey, provider])
  return { accounts, setAccounts, accountsLoaded, loadAccounts, mountedRef }
}
