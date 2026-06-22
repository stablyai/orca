/**
 * Shared helpers for the minted PTY session id format.
 *
 * Why split out of `src/main/daemon/pty-session-id.ts`: the renderer-side
 * merge in `mergeSnapshotAndSessions.ts` and the boot-time hydration in
 * `attach-main-window-services.ts` both need to recover the owning
 * worktreeId from a session id. Three call sites silently re-implementing
 * the same parser (one of them looser than the others) was the seed of
 * the resource-usage REMOTE-mislabel bug. Centralising the format here
 * keeps a single definition that both the main process and the renderer
 * can import.
 */

import { normalizeExecutionHostId } from './execution-host'

export const PTY_SESSION_ID_SEPARATOR = '@@'
export const WORKTREE_ID_SEPARATOR = '::'
const WORKTREE_KEY_PREFIX = 'orca-worktree://v1?'

function isCanonicalWorktreeKey(candidate: string): boolean {
  if (!candidate.startsWith(WORKTREE_KEY_PREFIX)) {
    return false
  }
  const params = new URLSearchParams(candidate.slice(WORKTREE_KEY_PREFIX.length))
  const keys = [...params.keys()]
  return (
    keys.length === 3 &&
    keys[0] === 'hostId' &&
    keys[1] === 'repoId' &&
    keys[2] === 'path' &&
    params.getAll('hostId').length === 1 &&
    params.getAll('repoId').length === 1 &&
    params.getAll('path').length === 1 &&
    normalizeExecutionHostId(params.get('hostId')) !== null &&
    (params.get('repoId')?.length ?? 0) > 0 &&
    (params.get('path')?.length ?? 0) > 0
  )
}

/**
 * Recover the owning worktreeId from a minted session id.
 *
 * Why stricter than `lastIndexOf('@@')`: callers that drive memory
 * attribution must not synthesize a worktreeId for a sessionId that was
 * not minted by us — e.g. a bare UUID. Requiring both the `@@` separator
 * AND the `${repoId}::${path}` shape rejects those imposters cleanly.
 * Returns `{ worktreeId: null }` when the id does not match the minted
 * format.
 */
export function parsePtySessionId(sessionId: string): { worktreeId: string | null } {
  const idx = sessionId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  if (idx <= 0) {
    return { worktreeId: null }
  }
  const candidate = sessionId.slice(0, idx)
  if (isCanonicalWorktreeKey(candidate)) {
    return { worktreeId: candidate }
  }
  // Why: require non-empty halves on both sides of `::` so degenerate
  // ids like `::@@…`, `repo::@@…`, or `::path@@…` don't synthesize a
  // phantom worktreeId for memory attribution.
  const sepIdx = candidate.indexOf(WORKTREE_ID_SEPARATOR)
  if (sepIdx <= 0 || sepIdx + WORKTREE_ID_SEPARATOR.length >= candidate.length) {
    return { worktreeId: null }
  }
  return { worktreeId: candidate }
}
