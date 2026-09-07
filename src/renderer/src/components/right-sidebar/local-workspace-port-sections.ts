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
    // Why: the old repo-scoped scan showed listeners from other repos as
    // External, without workspace-only actions or cross-worktree activation.
    // Keep that behavior now that the shared scan can attribute them globally.
    externalPorts: ports.flatMap((port) => {
      if (port.kind !== 'workspace') {
        return [port]
      }
      return port.owner.repoId === activeRepoId ? [] : [workspacePortAsExternal(port)]
    })
  }
}

/**
 * Whether the panel still renders its port sections under a failure notice.
 * Why: a failed scan retains the host's last-good ports, so hiding every
 * section would drop the stop and open actions for ports the status bar still
 * counts and lists.
 */
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
