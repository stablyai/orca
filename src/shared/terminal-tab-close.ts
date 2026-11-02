import type { ExecutionHostId } from './execution-host'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'

export type TerminalTabCloseRequest = {
  requestId: string
  tabId: string
  localPtyTeardownOwnedExternally?: boolean
  force?: boolean
  originalSurface?: TerminalSurfaceCloseIdentity
}

export type TerminalTabCloseResponse = {
  requestId: string
  error?: string
}

/** Captured presentation facts only narrow the authenticated terminal close. */
export type TerminalSurfaceCloseIdentity = {
  worktreeId: string
  tabId: string
  leafId: string
  createdAt: number | null
  generation: number
  hasLeaf: boolean
  ptyId: string | null
  incarnationId: string | null
}

export type TerminalSurfaceCloseCapture = {
  identity: TerminalSurfaceCloseIdentity
  holders: { hostId: ExecutionHostId; identity: TerminalSurfaceCloseIdentity | null }[]
}

export function isRetainedTerminalSurfaceIdentity(
  original: TerminalSurfaceCloseIdentity,
  current: TerminalSurfaceCloseIdentity | null
): boolean {
  return (
    current === null ||
    (current.worktreeId === original.worktreeId &&
      current.tabId === original.tabId &&
      current.leafId === original.leafId &&
      current.createdAt === original.createdAt &&
      current.generation === original.generation &&
      (!current.hasLeaf || original.hasLeaf) &&
      (current.ptyId === null || current.ptyId === original.ptyId) &&
      (current.incarnationId === null || current.incarnationId === original.incarnationId))
  )
}

export function terminalTreeHasLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  return (
    !!node &&
    (node.type === 'leaf'
      ? node.leafId === leafId
      : terminalTreeHasLeaf(node.first, leafId) || terminalTreeHasLeaf(node.second, leafId))
  )
}

export function captureTerminalSurfaceIdentity(
  state:
    | (Pick<WorkspaceSessionState, 'tabsByWorktree' | 'terminalLayoutsByTabId'> &
        Partial<Pick<WorkspaceSessionState, 'terminalPtyIncarnationsByPaneKey'>>)
    | null
    | undefined,
  worktreeId: string,
  tabId: string,
  leafId: string
): TerminalSurfaceCloseIdentity | null {
  const row = state?.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  if (!row || !state) {
    return null
  }
  const layout = state.terminalLayoutsByTabId[tabId]
  return {
    worktreeId,
    tabId,
    leafId,
    createdAt: row.createdAt,
    generation: row.generation ?? 0,
    hasLeaf: terminalTreeHasLeaf(layout?.root, leafId),
    ptyId: layout?.ptyIdsByLeafId?.[leafId] ?? null,
    incarnationId: state.terminalPtyIncarnationsByPaneKey?.[`${tabId}:${leafId}`] ?? null
  }
}

export function matchesTerminalSurfaceCapture(
  original: TerminalSurfaceCloseCapture,
  hostIds: readonly ExecutionHostId[],
  read: (hostId: ExecutionHostId) => Parameters<typeof captureTerminalSurfaceIdentity>[0]
): boolean {
  return (
    original.identity.hasLeaf &&
    original.holders.length > 0 &&
    original.holders.every((holder) =>
      isRetainedTerminalSurfaceIdentity(original.identity, holder.identity)
    ) &&
    [...new Set([...original.holders.map((holder) => holder.hostId), ...hostIds])].every(
      (hostId) => {
        const holder = original.holders.find((entry) => entry.hostId === hostId)
        const next = captureTerminalSurfaceIdentity(
          read(hostId),
          original.identity.worktreeId,
          original.identity.tabId,
          original.identity.leafId
        )
        return holder
          ? holder.identity
            ? isRetainedTerminalSurfaceIdentity(holder.identity, next)
            : next === null
          : next === null
      }
    )
  )
}
