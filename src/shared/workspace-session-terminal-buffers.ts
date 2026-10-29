import { SessionUnitIndex } from './session-unit-index'
import { SessionUnitReader } from './session-unit-reader'
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
  const reader = new SessionUnitReader(session, new SessionUnitIndex(session))
  reduceTerminalScrollbackBuffers(
    reader,
    new Set([
      ...Object.keys(session.terminalLayoutsByTabId ?? {}),
      ...Object.keys(session.localOnlyScrollbackByTabId ?? {})
    ]),
    new Map(repos.map((repo) => [repo.id, repo]))
  )
  return reader.snapshot()
}

export function reduceTerminalScrollbackBuffers(
  reader: SessionUnitReader,
  tabIds: Iterable<string>,
  repos: ReadonlyMap<string, RepoConnection>
): void {
  for (const tabId of tabIds) {
    const layout = reader.unit('terminalLayoutsByTabId', tabId).value
    const local = reader.unit('localOnlyScrollbackByTabId', tabId).value
    if (!layout?.buffersByLeafId && !layout?.scrollbackRefsByLeafId && !local) {
      continue
    }
    const owner = reader.terminalOwner(tabId, 'last')
    const ptyId = reader.terminalTab(tabId, 'last')?.ptyId
    const preserves =
      ptyId === null || shouldPreserveTerminalScrollbackBuffersForRepoMap(owner, repos)
    if (layout && (layout.buffersByLeafId || layout.scrollbackRefsByLeafId)) {
      if (preserves) {
        const capped = capTerminalScrollbackLeafBuffers(layout.buffersByLeafId)
        if (capped.changed) {
          reader.write('terminalLayoutsByTabId', tabId, {
            present: true,
            value: { ...layout, buffersByLeafId: capped.buffers }
          })
        }
      } else {
        const next = { ...layout }
        delete next.buffersByLeafId
        delete next.scrollbackRefsByLeafId
        reader.write('terminalLayoutsByTabId', tabId, { present: true, value: next })
      }
    }
    if (local) {
      const capped = preserves
        ? capTerminalScrollbackLeafBuffers(local)
        : { buffers: undefined, changed: true }
      if (capped.changed) {
        reader.write(
          'localOnlyScrollbackByTabId',
          tabId,
          capped.buffers
            ? { present: true, value: capped.buffers }
            : { present: false, value: undefined }
        )
      }
    }
  }
}
