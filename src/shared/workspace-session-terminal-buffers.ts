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
    // Why: when the repo catalog is not hydrated, treating the worktree as
    // remote avoids losing the only scrollback source a relay/runtime terminal
    // may have.
    // Why this direction is local to this decision: worktree-runtime-owner.ts resolves the same
    // unhydrated catalog to 'local'. Safe there (nothing is destroyed), data loss here. "Fail
    // open" names a direction per decision, never a house style — do not pattern-match it across
    // the two.
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
  let worktreeIdByTabId: Map<string, string> | null = null
  const tabsByWorktree = session.tabsByWorktree ?? {}
  const preservesScrollback = (tabId: string): boolean => {
    repoById ??= new Map(repos.map((repo) => [repo.id, repo] as const))
    if (!worktreeIdByTabId) {
      worktreeIdByTabId = new Map()
      for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
        for (const tab of tabs) {
          worktreeIdByTabId.set(tab.id, worktreeId)
        }
      }
    }
    return shouldPreserveTerminalScrollbackBuffersForRepoMap(worktreeIdByTabId.get(tabId), repoById)
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

  // The local-only home gets the same classification and cap; it is never externalized to refs,
  // so an uncapped entry here would sit inline in every persisted write.
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
    // Why: local daemon history/checkpoints are authoritative for restart
    // scrollback. Keeping renderer-captured buffers for local tabs makes every
    // persisted state write scale with old terminal output; remote/runtime tabs
    // keep them because teardown may leave no local history to cold-restore.
    ...(terminalLayoutsByTabId ? { terminalLayoutsByTabId } : {}),
    ...(localOnlyScrollbackByTabId ? { localOnlyScrollbackByTabId } : {})
  }
}
