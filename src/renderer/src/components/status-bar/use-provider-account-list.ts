import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  fetchProviderAccountsSnapshot,
  getProviderAccountsOwnerKey,
  invalidateProviderAccountsSnapshot,
  type ProviderAccountsSnapshot
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { observedProviderAccounts } from '@/runtime/provider-accounts/observations/observed-provider-accounts'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const noSubscription = () => () => {}
const noSnapshot = () => null
const accountListRefreshListeners = new Map<string, Set<() => void>>()
// Owners whose last account change may have applied on the host unseen. Never cleared: no later response proves that change settled.
const uncertainAccountLists = new Set<string>()
// What each owner's list last showed, so an uncertain owner's menu keeps it on screen while its open read runs.
const lastKnownAccountLists: {
  [Provider in 'claude' | 'codex']: Map<string, ProviderAccountsSnapshot[Provider]>
} = { claude: new Map(), codex: new Map() }

// Per list instance: only its latest read or selection result may apply.
type AccountListInstance = { current: boolean; ownerKey: string }
const accountListRequestVersions = new WeakMap<AccountListInstance, number>()

function startAccountListRequest(instance: AccountListInstance): number {
  const version = (accountListRequestVersions.get(instance) ?? 0) + 1
  accountListRequestVersions.set(instance, version)
  return version
}

function accountListKey(target: RuntimeClientTarget, provider: 'claude' | 'codex'): string {
  return `${getProviderAccountsOwnerKey(target)}:${provider}`
}

/** Reloads every mounted list of this owner. `unknown` is a rejected change, which may still have applied. */
export function refreshProviderAccountLists(
  target: RuntimeClientTarget,
  provider: 'claude' | 'codex',
  outcome: 'applied' | 'unknown' = 'applied'
): void {
  const key = accountListKey(target, provider)
  if (outcome === 'unknown') {
    uncertainAccountLists.add(key)
  }
  invalidateProviderAccountsSnapshot(target)
  accountListRefreshListeners.get(key)?.forEach((refresh) => refresh())
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
  const observing = observe && environmentId !== null
  const answer = useSyncExternalStore(
    observing ? observation.subscribe : noSubscription,
    observing ? observation.getSnapshot : noSnapshot,
    noSnapshot
  )
  const [local, setLocal] = useState(() => ({
    ownerKey,
    accounts:
      (uncertainAccountLists.has(ownerKey)
        ? lastKnownAccountLists[provider].get(ownerKey)
        : undefined) ?? initial,
    known: false
  }))
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
      startAccountListRequest(mountedRef)
      invalidateProviderAccountsSnapshot(ownerTarget)
      if (observing) {
        observation.setAccounts(next)
      } else {
        lastKnownAccountLists[provider].set(ownerKey, next)
        setLocal((previous) => ({
          ownerKey,
          accounts: next,
          known: previous.ownerKey === ownerKey && previous.known
        }))
      }
    },
    [mountedRef, observing, observation, ownerKey, ownerTarget, provider]
  )
  const loadAccounts = useCallback(async () => {
    if (!mountedRef.current) {
      return
    }
    const requestVersion = startAccountListRequest(mountedRef)
    const snapshot = await fetchProviderAccountsSnapshot(ownerTarget)
    if (!mountedRef.current || accountListRequestVersions.get(mountedRef) !== requestVersion) {
      return
    }
    if (snapshot.failedProviders?.includes(provider)) {
      console.error(`${provider} account list failed; keeping previous state.`)
      return
    }
    if (observing) {
      observation.setAccounts(snapshot[provider])
    } else {
      lastKnownAccountLists[provider].set(ownerKey, snapshot[provider])
      setLocal({ ownerKey, accounts: snapshot[provider], known: true })
    }
  }, [provider, ownerTarget, ownerKey, observing, observation, mountedRef])
  const logLoadFailure = useCallback(
    (error: unknown) => console.error(`Failed to load ${provider} accounts:`, error),
    [provider]
  )
  // One fresh read per admission; the parent menu can admit it before the submenu expands.
  const reloadUncertainAccountsOnOpen = useCallback((): boolean => {
    if (!uncertainAccountLists.has(ownerKey)) {
      return false
    }
    // Why: a request issued before this admission may predate the unseen change.
    invalidateProviderAccountsSnapshot(ownerTarget)
    void loadAccounts().catch(logLoadFailure)
    return true
  }, [loadAccounts, logLoadFailure, ownerKey, ownerTarget])
  useEffect(() => {
    if (!observing && !uncertainAccountLists.has(ownerKey)) {
      void loadAccounts().catch(logLoadFailure)
    }
  }, [loadAccounts, logLoadFailure, observing, ownerKey, syncKey])
  useEffect(() => {
    const refresh = () => {
      void loadAccounts().catch(logLoadFailure)
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
  }, [loadAccounts, logLoadFailure, ownerKey])
  return {
    accounts,
    setAccounts,
    accountsLoaded,
    loadAccounts,
    reloadUncertainAccountsOnOpen,
    mountedRef
  }
}
