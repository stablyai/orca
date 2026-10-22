import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchProviderAccountsSnapshot,
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** The switchers share snapshot loading; a failed provider half never replaces its roster. */
export function useProviderAccountList<Provider extends 'claude' | 'codex'>(
  provider: Provider,
  target: RuntimeClientTarget,
  syncKey: string,
  initial: ProviderAccountsSnapshot[Provider],
  observe = false
) {
  const [accounts, setAccounts] = useState(initial)
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const loadAccounts = useCallback(async () => {
    const snapshot = await fetchProviderAccountsSnapshot(target)
    if (snapshot.failedProviders?.includes(provider)) {
      console.error(`${provider} account list failed; keeping previous state.`)
      return
    }
    if (mountedRef.current) {
      setAccounts(snapshot[provider])
      setAccountsLoaded(true)
    }
  }, [provider, target])
  useEffect(() => {
    if (observe && target.kind === 'environment') {
      setAccountsLoaded(false)
      const watcher = watchProviderAccounts(target, {
        onSnapshot: (snapshot) => {
          const known = !snapshot.failedProviders?.includes(provider)
          setAccountsLoaded(known)
          if (known) {
            setAccounts(snapshot[provider])
          }
        },
        onError: () => setAccountsLoaded(false),
        onClosedAfterSnapshot: () => setAccountsLoaded(false)
      })
      return () => watcher.close()
    }
    void loadAccounts().catch((error: unknown) => {
      console.error(`Failed to load ${provider} accounts:`, error)
    })
    return undefined
  }, [loadAccounts, observe, provider, syncKey, target])
  return { accounts, setAccounts, accountsLoaded, loadAccounts, mountedRef }
}
