export const WORKTREE_CREATE_PREPARATION_DIRECTORY = '.orca-preparing'
export const WORKTREE_CREATE_PREPARATION_LOCK_PREFIX = 'orca-create-preparation:v1:'
const WORKTREE_CREATE_PREPARATION_ID_PATTERN =
  /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createWorktreePreparationLockReason(sessionId: string): string {
  return `${WORKTREE_CREATE_PREPARATION_LOCK_PREFIX}${process.pid}:${sessionId}`
}

export function parseWorktreePreparationOwnerPid(lockReason?: string): number | null {
  if (!lockReason?.startsWith(WORKTREE_CREATE_PREPARATION_LOCK_PREFIX)) {
    return null
  }
  const pid = Number(lockReason.slice(WORKTREE_CREATE_PREPARATION_LOCK_PREFIX.length).split(':')[0])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function parsePathPreparationId(path: string): string | null {
  const pathParts = path.split(/[\\/]+/)
  const preparationIndex = pathParts.lastIndexOf(WORKTREE_CREATE_PREPARATION_DIRECTORY)
  const preparationId = preparationIndex === -1 ? undefined : pathParts[preparationIndex + 1]
  return preparationId && WORKTREE_CREATE_PREPARATION_ID_PATTERN.test(preparationId)
    ? preparationId
    : null
}

export function parseWorktreePreparationPathOwnerPid(path: string): number | null {
  const preparationId = parsePathPreparationId(path)
  const pid = Number(preparationId?.split('-')[0])
  return preparationId && Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/**
 * The spare's `<pid>-<uuid>` id, from its `.orca-preparing/<id>` path or, once a handover moved it
 * while still locked, from the lock reason, which embeds the same id.
 */
export function parseWorktreePreparationId(worktree: {
  path: string
  lockReason?: string
}): string | null {
  const fromPath = parsePathPreparationId(worktree.path)
  if (fromPath) {
    return fromPath
  }
  if (!worktree.lockReason?.startsWith(WORKTREE_CREATE_PREPARATION_LOCK_PREFIX)) {
    return null
  }
  const sessionId = worktree.lockReason
    .slice(WORKTREE_CREATE_PREPARATION_LOCK_PREFIX.length)
    .split(':')[1]
  return sessionId && WORKTREE_CREATE_PREPARATION_ID_PATTERN.test(sessionId) ? sessionId : null
}

export function isWorktreeCreatePreparation(worktree: {
  path: string
  lockReason?: string
  branch?: string
}): boolean {
  // The Git lock reason is the durable ownership proof. A path can be chosen
  // by a user (including for an uncommitted detached worktree), so path shape
  // alone must never hide it. An unlocked spare that was checked out stays for
  // the user to remove; the startup sweep force-removes an unlocked one only
  // when it was never checked out (no index) and holds nothing but HEAD's files.
  return parseWorktreePreparationOwnerPid(worktree.lockReason) !== null
}
