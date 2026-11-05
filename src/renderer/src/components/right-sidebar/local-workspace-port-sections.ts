import type { WorkspacePort } from '../../../../shared/workspace-ports'

export function getLocalWorkspacePortSections(
  scan: { ports: WorkspacePort[] } | null | undefined,
  activeRepoId: string | null | undefined,
  activeWorktreeId: string | null | undefined
): {
  activePorts: WorkspacePort[]
  otherWorkspacePorts: WorkspacePort[]
  externalPorts: WorkspacePort[]
} {
  const ports = scan?.ports ?? []
  return {
    activePorts: ports.filter(
      (port) =>
        port.kind === 'workspace' &&
        port.owner.repoId === activeRepoId &&
        port.owner.worktreeId === activeWorktreeId
    ),
    otherWorkspacePorts: ports.filter(
      (port) =>
        port.kind === 'workspace' &&
        port.owner.repoId === activeRepoId &&
        port.owner.worktreeId !== activeWorktreeId
    ),
    // Preserve old repo scope: other projects stay External without workspace activation/actions despite global attribution.
    externalPorts: ports.flatMap((port) => {
      if (port.kind !== 'workspace') {
        return [port]
      }
      return port.owner.repoId === activeRepoId ? [] : [workspacePortAsExternal(port)]
    })
  }
}

/** Failed scans retain last-good ports; keep their actions available while the status bar still lists them. */
export function shouldShowLocalWorkspacePortSections(
  scan: { unavailableReason?: string } | null | undefined,
  sections: { activePorts: unknown[]; otherWorkspacePorts: unknown[]; externalPorts: unknown[] }
): boolean {
  if (!scan?.unavailableReason) {
    return true
  }
  return (
    sections.activePorts.length > 0 ||
    sections.otherWorkspacePorts.length > 0 ||
    sections.externalPorts.length > 0
  )
}

function workspacePortAsExternal(port: WorkspacePort & { kind: 'workspace' }): WorkspacePort {
  return {
    id: port.id,
    bindHost: port.bindHost,
    connectHost: port.connectHost,
    port: port.port,
    pid: port.pid,
    processName: port.processName,
    protocol: port.protocol,
    kind: 'external'
  }
}
