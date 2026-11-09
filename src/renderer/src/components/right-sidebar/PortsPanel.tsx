import React, { useCallback, useMemo } from 'react'
import { Server } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/workspaces/selection/use-selected-worktree'
import { useTranslate } from '@/i18n/use-translate'
import { LocalWorkspacePortsPanel } from './local-workspace-ports-panel'
import { SshPortsPanel } from './ssh-ports-panel'
import { HostScopedPortsPanel } from './host-scoped-ports-panel'
import { CloudSharedLinksSection } from './cloud-share/cloud-shared-links-section'
import { SharePortMenuItem, useSharePortAction } from './cloud-share/use-share-port-action'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import {
  getPortsPanelOwnerKey,
  portsPanelForwardTargetId,
  portsPanelHostForOwnerKey
} from './ports-panel-host'

export default function PortsPanel({ isVisible }: { isVisible: boolean }): React.JSX.Element {
  const t = useTranslate()
  const activeWorktree = useActiveWorktree()
  const workspaceId = activeWorktree?.id ?? null
  const ownerKey = useAppStore((state) => getPortsPanelOwnerKey(state, workspaceId))
  const host = useMemo(() => portsPanelHostForOwnerKey(ownerKey), [ownerKey])
  const sshForwardTargetId = useAppStore((state) =>
    portsPanelForwardTargetId(host, state.runtimeEnvironments)
  )
  // Orca Cloud workspaces are paired endpoints; non-cloud environments answer `unsupported`.
  const environmentId =
    host.kind === 'endpoint' && host.target.kind === 'environment'
      ? host.target.environmentId
      : null
  const shareAction = useSharePortAction(environmentId)
  const { available: shareAvailable, openShareDialog } = shareAction
  // Stable, so the forwarding menu memo only recomputes when sharing becomes (un)available.
  const sharePortMenuItems = useCallback(
    (port: WorkspacePort) => (
      <SharePortMenuItem port={port.port} action={{ available: shareAvailable, openShareDialog }} />
    ),
    [shareAvailable, openShareDialog]
  )
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
      return (
        <LocalWorkspacePortsPanel
          isVisible={isVisible}
          runtimeTarget={host.target}
          sshForwardTargetId={sshForwardTargetId}
          portMenuItems={shareAvailable ? sharePortMenuItems : undefined}
          footer={(activePorts) => (
            <CloudSharedLinksSection
              action={shareAction}
              isVisible={isVisible}
              detectedPorts={[...new Set(activePorts.map((port) => port.port))]}
            />
          )}
        />
      )
    case 'host-scoped':
    case 'unknown':
      return (
        <div className="flex flex-col items-center justify-center h-full px-4 text-center text-muted-foreground">
          <Server size={32} className="mb-3 opacity-50" />
          <p className="text-sm">
            {t('auto.components.right.sidebar.PortsPanel.153d3a8026', 'Workspace host unknown')}
          </p>
        </div>
      )
  }
}
