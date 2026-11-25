import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchProviderAccountsSnapshot,
  getProviderAccountsOwnerKey,
  type ProviderAccountsSnapshot
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** The switchers share snapshot loading; a failed provider half never replaces its roster. */
export function useProviderAccountList<Provider extends 'claude' | 'codex'>(
  provider: Provider,
  target: RuntimeClientTarget,
  syncKey: string,
  initial: ProviderAccountsSnapshot[Provider],
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
  const [local, setLocal] = useState({ ownerKey, accounts: initial, known: false })
  // Why: a list read started before a selection can settle after the selection reply.
  const writeSequenceRef = useRef(0)
  // Reused in-flight reads keep the sequence from when this list first awaited them.
  const readStartSequencesRef = useRef(new WeakMap<Promise<ProviderAccountsSnapshot>, number>())
  const accounts = local.ownerKey === ownerKey ? local.accounts : initial
  const accountsLoaded = local.ownerKey === ownerKey && local.known
  const setAccounts = useCallback(
    (next: ProviderAccountsSnapshot[Provider]) => {
      if (!mountedRef.current) {
        return
      }
      writeSequenceRef.current += 1
      setLocal((previous) => ({
        ownerKey,
        accounts: next,
        known: previous.ownerKey === ownerKey && previous.known
      }))
    },
    [mountedRef, ownerKey]
  )
  const loadAccounts = useCallback(async () => {
    if (!enabled) {
      return
    }
    const request = fetchProviderAccountsSnapshot(ownerTarget)
    const writeSequence = readStartSequencesRef.current.get(request) ?? writeSequenceRef.current
    readStartSequencesRef.current.set(request, writeSequence)
    const snapshot = await request
    if (snapshot.failedProviders?.includes(provider)) {
      console.error(`${provider} account list failed; keeping previous state.`)
      return
    }
    if (mountedRef.current && writeSequence === writeSequenceRef.current) {
      setLocal({ ownerKey, accounts: snapshot[provider], known: true })
    }
  }, [provider, ownerTarget, ownerKey, mountedRef, enabled])
  useEffect(() => {
    if (enabled) {
      void loadAccounts().catch((error: unknown) =>
        console.error(`Failed to load ${provider} accounts:`, error)
      )
    }
  }, [loadAccounts, provider, syncKey, enabled])
  return { accounts, setAccounts, accountsLoaded, loadAccounts, mountedRef }
}
