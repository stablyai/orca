import { useEffect, useMemo } from 'react'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useAppStore } from '@/store'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host/execution-host'
import { useBotHostLabels } from './use-bot-host-label'

export type BotSidebarHostFilter = {
  scope: ExecutionHostScope
  pairedHosts: readonly { id: ExecutionHostId; label: string }[]
  onChange: (scope: ExecutionHostScope) => void
}

export function useBotSidebarHostFilter(): BotSidebarHostFilter & {
  removed: boolean
  webClient: boolean
} {
  const environments = useAppStore((s) => s.runtimeEnvironments)
  const hydrated = useAppStore((s) => s.runtimeEnvironmentCatalogHydrated)
  const webClient = isPairedWebClientWindow()
  const pairedIds = useMemo<readonly ExecutionHostId[]>(
    () => (webClient ? [] : environments.map(({ id }) => toRuntimeExecutionHostId(id))),
    [environments, webClient]
  )
  const labels = useBotHostLabels(pairedIds)
  const pairedHosts = useMemo(
    () => pairedIds.map((id) => ({ id, label: labels.get(id) || id })),
    [pairedIds, labels]
  )
  const selection = useAppStore((s) => s.botSidebarHostFilter)
  const setSelection = useAppStore((s) => s.setBotSidebarHostFilter)
  // Only removal from the saved catalog clears a selection, not a disconnect or an empty bot list.
  const stale =
    hydrated &&
    selection.scope !== ALL_EXECUTION_HOSTS_SCOPE &&
    selection.scope !== LOCAL_EXECUTION_HOST_ID &&
    !pairedIds.includes(selection.scope)
  useEffect(() => {
    if (stale && useAppStore.getState().botSidebarHostFilter === selection) {
      setSelection({ scope: ALL_EXECUTION_HOSTS_SCOPE, removed: true })
    }
  }, [selection, setSelection, stale])
  return {
    scope: stale ? ALL_EXECUTION_HOSTS_SCOPE : selection.scope,
    removed: selection.removed,
    webClient,
    pairedHosts,
    onChange: (scope) => setSelection({ scope, removed: false })
  }
}
