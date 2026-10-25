import type { Repo } from './repo-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { getRepoIdFromWorktreeId } from './worktree/id'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from './terminal-scrollback-limits'
import { clampUtf8TextTail, isUtf8ByteLengthWithinLimit } from './utf8-byte-limits'
import { parseExecutionHostId } from './execution-host'
import { ownRetainedString } from './own-retained-string'

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
    // An unhydrated repo catalog is remote for scrollback retention: dropping its only restore copy loses data. worktree-runtime-owner may safely choose local for its non-destructive decision; do not copy that default here.
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
  if (isUtf8ByteLengthWithinLimit(buffer, TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT)) {
    return buffer
  }
  return ownRetainedString(
    clampUtf8TextTail(buffer, TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT).text
  )
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

/** Both homes a tab's scrollback can persist in; every one must pass through the cap below. */
export const TERMINAL_SCROLLBACK_SESSION_HOMES = [
  'terminalLayoutsByTabId',
  'localOnlyScrollbackByTabId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

export function pruneLocalTerminalScrollbackBuffers(
  session: WorkspaceSessionState,
  repos: readonly RepoConnection[]
): WorkspaceSessionState {
  let repoById: Map<string, RepoConnection> | null = null
  let tabById: Map<string, { worktreeId: string; ptyId: string | null }> | null = null
  const tabsByWorktree = session.tabsByWorktree ?? {}
  const preservesScrollback = (tabId: string): boolean => {
    repoById ??= new Map(repos.map((repo) => [repo.id, repo] as const))
    if (!tabById) {
      tabById = new Map()
      for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
        for (const tab of tabs) {
          tabById.set(tab.id, { worktreeId, ptyId: tab.ptyId })
        }
      }
    }
    const tab = tabById.get(tabId)
    // A dormant tab has no live PTY to replay from, so its saved buffer is the only copy.
    return (
      tab?.ptyId === null ||
      shouldPreserveTerminalScrollbackBuffersForRepoMap(tab?.worktreeId, repoById)
    )
  }

  const terminalLayoutsByTabIdForRead = session.terminalLayoutsByTabId ?? {}
  let terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(terminalLayoutsByTabIdForRead)) {
    if (!layout.buffersByLeafId && !layout.scrollbackRefsByLeafId) {
      continue
    }
    if (preservesScrollback(tabId)) {
      const capped = capTerminalScrollbackLeafBuffers(layout.buffersByLeafId)
      if (capped.changed) {
        terminalLayoutsByTabId ??= { ...terminalLayoutsByTabIdForRead }
        terminalLayoutsByTabId[tabId] = { ...layout, buffersByLeafId: capped.buffers }
      }
      continue
    }

    terminalLayoutsByTabId ??= { ...terminalLayoutsByTabIdForRead }
    const layoutWithoutBuffers = { ...layout }
    delete layoutWithoutBuffers.buffersByLeafId
    delete layoutWithoutBuffers.scrollbackRefsByLeafId
    terminalLayoutsByTabId[tabId] = layoutWithoutBuffers
  }

  // Cap the local-only home too: it stays inline rather than being externalized to refs.
  const localOnlyForRead = session.localOnlyScrollbackByTabId
  let localOnlyScrollbackByTabId: Record<string, Record<string, string>> | null = null
  for (const [tabId, buffers] of Object.entries(localOnlyForRead ?? {})) {
    const capped = preservesScrollback(tabId)
      ? capTerminalScrollbackLeafBuffers(buffers)
      : { buffers: undefined, changed: true }
    if (!capped.changed) {
      continue
    }
    localOnlyScrollbackByTabId ??= { ...localOnlyForRead }
    if (capped.buffers) {
      localOnlyScrollbackByTabId[tabId] = capped.buffers
    } else {
      delete localOnlyScrollbackByTabId[tabId]
    }
  }

  if (!terminalLayoutsByTabId && !localOnlyScrollbackByTabId) {
    return session
  }

  return {
    ...session,
    // Local daemon history/checkpoints own restart scrollback. Retain remote/runtime captures because teardown may leave no local history.
    ...(terminalLayoutsByTabId ? { terminalLayoutsByTabId } : {}),
    ...(localOnlyScrollbackByTabId ? { localOnlyScrollbackByTabId } : {})
  }
}
