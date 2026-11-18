import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { subscribeWorkspaceAccountSettingsChanged } from '@/runtime/provider-accounts/observations/workspace-account-settings-changes'
import { getProviderAccountsOwnerKey } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/rpc/targets/runtime-client-target'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { HistoryAccountCatalog, HistoryAccountCatalogs } from './history-account-context'

export function useHistoryAccountCatalogs(
  sessions: readonly AiVaultSession[],
  refreshKey?: string
) {
  const settings = useAppStore((state) => state.settings)
  const [catalogs, setCatalogs] = useState<HistoryAccountCatalogs>({})
  const [revision, setRevision] = useState(0)
  const hostKey = JSON.stringify(
    [...new Set(sessions.map((session) => session.executionHostId))].sort()
  )
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener('orca-history-continuations-changed', refresh)
    return () => window.removeEventListener('orca-history-continuations-changed', refresh)
  }, [])
  useEffect(() => {
    const hosts: string[] = JSON.parse(hostKey)
    const owners = new Set(
      hosts.flatMap((host) => {
        const parsed = parseRoutableExecutionHostId(host)
        const target = parsed ? runtimeRpcTargetForAuthorityKey(parsed.id) : null
        return target ? [getProviderAccountsOwnerKey(target)] : []
      })
    )
    return subscribeWorkspaceAccountSettingsChanged((target) => {
      if (owners.has(getProviderAccountsOwnerKey(target))) {
        setRevision((value) => value + 1)
      }
    })
  }, [hostKey])
  useEffect(() => {
    let current = true
    const hosts: string[] = JSON.parse(hostKey)
    void Promise.all(
      hosts.map(async (host) => {
        const parsedHost = parseRoutableExecutionHostId(host)
        const target = parsedHost ? runtimeRpcTargetForAuthorityKey(parsedHost.id) : null
        if (!target) {
          return null
        }
        try {
          const [accounts, result] = await Promise.all([
            callRuntimeRpc<Pick<HistoryAccountCatalog, 'claude' | 'codex'>>(
              target,
              'accounts.list',
              { refreshUsage: false }
            ),
            callRuntimeRpc<Pick<HistoryAccountCatalog, 'settings'>>(
              target,
              'settings.get',
              undefined
            )
          ])
          let continuations: HistoryAccountCatalog['continuations']
          if (result.settings.historyResumeAccountsSupported) {
            const ledger = await callRuntimeRpc<{
              continuationCatalog?: HistoryAccountCatalog['continuations']
            }>(target, 'aiVault.prepareSessionResume', {
              agent: 'codex',
              filePath: '/history-catalog',
              sessionId: 'catalog',
              codexHome: null,
              historyCatalog: true
            })
            continuations = ledger.continuationCatalog
          }
          return { host, catalog: { ...accounts, settings: result.settings, continuations } }
        } catch {
          return null
        }
      })
    ).then((results) => {
      if (current) {
        setCatalogs(
          Object.fromEntries(
            results.flatMap((result) => (result ? [[result.host, result.catalog]] : []))
          )
        )
      }
    })
    return () => {
      current = false
    }
  }, [
    hostKey,
    revision,
    refreshKey,
    settings?.claudeManagedAccounts,
    settings?.codexManagedAccounts,
    settings?.activeClaudeManagedAccountId,
    settings?.activeCodexManagedAccountId,
    settings?.managedAccountDisplayNames
  ])
  return useMemo(
    () =>
      settings && catalogs[LOCAL_EXECUTION_HOST_ID]
        ? {
            ...catalogs,
            [LOCAL_EXECUTION_HOST_ID]: {
              ...catalogs[LOCAL_EXECUTION_HOST_ID],
              settings: {
                ...settings,
                historyResumeAccountsSupported:
                  catalogs[LOCAL_EXECUTION_HOST_ID].settings.historyResumeAccountsSupported
              }
            }
          }
        : catalogs,
    [catalogs, settings]
  )
}
