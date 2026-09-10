import { useEffect, useMemo } from 'react'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { MaestroWorkspaceCanvas } from './MaestroWorkspaceCanvas'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  scheduleMaestroTerminalPreload,
  terminalWorkspaceIdForMaestroKey
} from './maestro-terminal-preload'

export function getPinnedRuntimeTarget(executionHostId: string): RuntimeClientTarget | null {
  const host = parseExecutionHostId(executionHostId)
  if (!host) {
    return null
  }
  switch (host.kind) {
    case 'local':
    case 'ssh':
      // SSH Canvas anchors are indexed by the local Orca runtime.
      return { kind: 'local' }
    case 'runtime':
      return { kind: 'environment', environmentId: host.environmentId }
  }
}

export function MaestroSurface({ tab }: { tab: Tab }): React.JSX.Element {
  const executionHostId = tab.maestroExecutionHostId
  const workspaceKey = tab.maestroWorkspaceKey
  const target = useMemo(
    () => (executionHostId ? getPinnedRuntimeTarget(executionHostId) : null),
    [executionHostId]
  )
  const scope = useMemo(
    () =>
      executionHostId && workspaceKey
        ? { execution_host_id: executionHostId, workspace_key: workspaceKey }
        : null,
    [executionHostId, workspaceKey]
  )
  useEffect(() => {
    if (!target || !workspaceKey) {
      return
    }
    const worktreeId = terminalWorkspaceIdForMaestroKey(workspaceKey)
    if (!worktreeId) {
      return
    }
    return scheduleMaestroTerminalPreload({
      worktreeId,
      getTerminalTabIds: () =>
        (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).map(
          (terminalTab) => terminalTab.id
        )
    })
  }, [target, workspaceKey])
  if (!target || !scope) {
    return (
      <main className="flex size-full items-center justify-center bg-background p-6">
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.maestro.MaestroSurface.ee4d1c1e27',
            'Workspace Canvas scope is unavailable.'
          )}
        </p>
      </main>
    )
  }
  return <MaestroWorkspaceCanvas target={target} scope={scope} />
}
