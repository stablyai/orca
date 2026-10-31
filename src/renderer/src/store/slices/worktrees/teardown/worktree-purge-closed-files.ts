import type { AppState } from '../../../types'
import type { WorktreePurgeTarget } from '../../worktree-helpers'
import { captureWorkspaceRemovalScope } from './workspace-removal-scope'

/** Preflight and accepted removal use the same positive source/resource attribution. */
export function worktreePurgeClosedFileIds(
  s: AppState,
  targets: readonly WorktreePurgeTarget[]
): Set<string> {
  const closed = new Set<string>()
  for (const target of targets) {
    if (!target.hostId) {
      for (const file of s.openFiles ?? []) {
        if (file.worktreeId === target.id) {
          closed.add(file.id)
          if (file.markdownPreviewSourceFileId) {
            closed.add(file.markdownPreviewSourceFileId)
          }
        }
      }
    }
    const scope = captureWorkspaceRemovalScope(s, {
      id: target.id,
      hostId: target.hostId ?? 'local'
    })
    for (const { removed, files } of scope.sources) {
      for (const id of removed.fileIds) {
        closed.add(id)
      }
      for (const file of files) {
        if (file.markdownPreviewSourceFileId) {
          closed.add(file.markdownPreviewSourceFileId)
        }
      }
    }
  }
  return closed
}
