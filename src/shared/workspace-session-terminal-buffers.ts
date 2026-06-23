import type { Repo, WorkspaceSessionState } from './types'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { getRepoIdFromWorktreeId } from './worktree-id'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from './terminal-scrollback-limits'
import { clampUtf8TextTail, measureUtf8ByteLength } from './utf8-byte-limits'
import { parseExecutionHostId } from './execution-host'

export type RepoConnection = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

type RepoTerminalScrollbackOwner = Pick<RepoConnection, 'connectionId' | 'executionHostId'>

function repoNeedsRendererCapturedScrollback(repo: RepoTerminalScrollbackOwner): boolean {
  if (repo.connectionId) {
    return true
  }
  const parsedHost = parseExecutionHostId(repo.executionHostId)
  return parsedHost !== null && parsedHost.kind !== 'local'
}

function shouldPreserveTerminalScrollbackBuffersForRepoMap(
  worktreeId: string | undefined,
  repoById: ReadonlyMap<string, RepoTerminalScrollbackOwner>
): boolean {
  if (worktreeId === undefined || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return false
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const repo = repoById.get(repoId)
  if (repo && repoNeedsRendererCapturedScrollback(repo)) {
    return true
  }
  if (!repoById.has(repoId)) {
    // Why: when the repo catalog is not hydrated, treating the worktree as
    // remote avoids losing the only scrollback source a relay/runtime terminal
    // may have.
    return true
  }
  return false
}

export function shouldPreserveTerminalScrollbackBuffers(
  worktreeId: string | undefined,
  repos: readonly RepoConnection[]
): boolean {
  return shouldPreserveTerminalScrollbackBuffersForRepoMap(
    worktreeId,
    new Map(repos.map((repo) => [repo.id, repo] as const))
  )
}

export function capTerminalScrollbackSessionBuffer(buffer: string): string {
  if (
    buffer.length <= TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT &&
    !measureUtf8ByteLength(buffer, {
      stopAfterBytes: TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
    }).exceededLimit
  ) {
    return buffer
  }
  return clampUtf8TextTail(buffer, TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT).text
}

function capTerminalScrollbackLeafBuffers(buffers: Record<string, string> | undefined): {
  buffers: Record<string, string> | undefined
  changed: boolean
} {
  if (!buffers) {
    return { buffers: undefined, changed: false }
  }
  let changed = false
  const capped: Record<string, string> = {}
  for (const [leafId, buffer] of Object.entries(buffers)) {
    const next = capTerminalScrollbackSessionBuffer(buffer)
    capped[leafId] = next
    changed ||= next !== buffer
  }
  return { buffers: Object.keys(capped).length > 0 ? capped : undefined, changed }
}

export function pruneLocalTerminalScrollbackBuffers(
  session: WorkspaceSessionState,
  repos: readonly RepoConnection[]
): WorkspaceSessionState {
  const repoById = new Map(repos.map((repo) => [repo.id, repo] as const))
  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }

  let terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
    if (!layout.buffersByLeafId && !layout.scrollbackRefsByLeafId) {
      continue
    }
    const worktreeId = worktreeIdByTabId.get(tabId)
    if (shouldPreserveTerminalScrollbackBuffersForRepoMap(worktreeId, repoById)) {
      const capped = capTerminalScrollbackLeafBuffers(layout.buffersByLeafId)
      if (capped.changed) {
        terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
        terminalLayoutsByTabId[tabId] = { ...layout, buffersByLeafId: capped.buffers }
      }
      continue
    }

    terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
    const layoutWithoutBuffers = { ...layout }
    delete layoutWithoutBuffers.buffersByLeafId
    delete layoutWithoutBuffers.scrollbackRefsByLeafId
    terminalLayoutsByTabId[tabId] = layoutWithoutBuffers
  }

  if (!terminalLayoutsByTabId) {
    return session
  }

  return {
    ...session,
    // Why: local daemon history/checkpoints are authoritative for restart
    // scrollback. Keeping renderer-captured buffers for local tabs makes every
    // persisted state write scale with old terminal output; remote/runtime tabs
    // keep them because teardown may leave no local history to cold-restore.
    terminalLayoutsByTabId
  }
}
