import React, { useMemo } from 'react'
import { Server } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { LocalWorkspacePortsPanel } from './local-workspace-ports-panel'
import { SshPortsPanel } from './ssh-ports-panel'
import { HostScopedPortsPanel } from './host-scoped-ports-panel'
import { getPortsPanelOwnerKey, portsPanelHostForOwnerKey } from './ports-panel-host'

export { getLocalWorkspacePortSections } from './local-workspace-port-sections'
export {
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  scanWorkspacePortsForTarget
} from '@/lib/workspace-port-actions'

export default function PortsPanel({ isVisible }: { isVisible: boolean }): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const workspaceId = activeWorktree?.id ?? null
  const ownerKey = useAppStore((state) => getPortsPanelOwnerKey(state, workspaceId))
  const host = useMemo(() => portsPanelHostForOwnerKey(ownerKey), [ownerKey])
  const scopedHost = useMemo(
    () =>
      host.kind === 'host-scoped' && workspaceId
        ? { route: host.route, executionHostId: host.executionHostId, worktreeId: workspaceId }
        : null,
    [host, workspaceId]
  )

  if (!workspaceId) {
    return <LocalWorkspacePortsPanel isVisible={isVisible} runtimeTarget={null} />
  }
  if (scopedHost) {
    return <HostScopedPortsPanel host={scopedHost} isVisible={isVisible} />
  }
  switch (host.kind) {
    case 'direct-ssh':
      return <SshPortsPanel key={host.connectionId} activeConnectionId={host.connectionId} />
    case 'endpoint':
      return <LocalWorkspacePortsPanel isVisible={isVisible} runtimeTarget={host.target} />
    case 'host-scoped':
    case 'unknown':
      return (
        <div className="flex flex-col items-center justify-center h-full px-4 text-center text-muted-foreground">
          <Server size={32} className="mb-3 opacity-50" />
          <p className="text-sm">
            {translate(
              'auto.components.right.sidebar.PortsPanel.153d3a8026',
              'Workspace host unknown'
            )}
          </p>
        </div>
      )
  }
}
