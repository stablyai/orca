import { splitWorktreeId } from '../../../shared/worktree/id'

/** True while a worktree's remote tab state may still be on its way in — an
 *  auto-created terminal in that window buries the restored tabs behind a junk
 *  tab. `connectionId` semantics follow getConnectionId: null is local,
 *  undefined means the owning repo has not landed in the store yet (too early
 *  to know). Both state inputs live in the ssh slice, so subscribers re-check
 *  when hydration lands or a pending path resolves. */
export function shouldDeferInitialTerminalCreation(
  worktreeId: string,
  connectionId: string | null | undefined,
  hydratedTargetIds: ReadonlySet<string>,
  pendingPathsByTargetId: Readonly<Record<string, readonly string[]>>
): boolean {
  if (connectionId === undefined) {
    return true
  }
  if (connectionId === null) {
    return false
  }
  if (!hydratedTargetIds.has(connectionId)) {
    return true
  }
  const worktreePath = splitWorktreeId(worktreeId)?.worktreePath
  return (
    worktreePath != null && (pendingPathsByTargetId[connectionId]?.includes(worktreePath) ?? false)
  )
}
