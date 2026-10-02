import type { Tab } from '../../../../../../shared/tab-types'
import type { OpenFile } from '../types/open-file'
import { isEditorTabContentType } from '../tabs/editor-tab-content-type'

/**
 * Open documents with no editor-family tab left. They render nowhere, but the active-surface
 * fallback still selects one, which is how a closed file comes back on the next restart.
 */
export function collectOrphanEditorFileIds(
  editorFileIds: ReadonlySet<string>,
  tabs: readonly Tab[],
  activeFileId: string | null | undefined
): string[] {
  if (editorFileIds.size === 0) {
    return []
  }
  const tabbedEntityIds = new Set(
    tabs.filter((tab) => isEditorTabContentType(tab.contentType)).map((tab) => tab.entityId)
  )
  return [...editorFileIds].filter(
    (fileId) => !tabbedEntityIds.has(fileId) && fileId !== activeFileId
  )
}

/**
 * Orphans per worktree. Why not one flat set: an unowned editor id is the bare file path, so the
 * same id can name a live document in another worktree — a flat set sweeps that one too.
 */
export function collectHydratedOrphanEditorFileIds(
  openFiles: readonly Pick<OpenFile, 'id' | 'isDirty' | 'worktreeId'>[],
  tabsByWorktree: Record<string, Tab[]>,
  activeFileIdByWorktree: Record<string, string | null>,
  editorDrafts: Record<string, string>
): Map<string, Set<string>> {
  const fileIdsByWorktree = new Map<string, Set<string>>()
  for (const file of openFiles) {
    // Why: an unsaved buffer must survive the sweep; only a clean document is disposable chrome.
    // Why the draft check: a draft is unsaved work whether or not the caller has flushed isDirty,
    // so the collector must never depend on that flag alone.
    if (file.isDirty === true || editorDrafts[file.id] !== undefined) {
      continue
    }
    const fileIds = fileIdsByWorktree.get(file.worktreeId)
    if (fileIds) {
      fileIds.add(file.id)
      continue
    }
    fileIdsByWorktree.set(file.worktreeId, new Set([file.id]))
  }
  const orphanFileIdsByWorktree = new Map<string, Set<string>>()
  for (const [worktreeId, fileIds] of fileIdsByWorktree) {
    const tabs = tabsByWorktree[worktreeId]
    // Why: missing = unknown, skip; empty = known, prune — a hydrated but empty tab list is
    // positive evidence that no editor tab renders those documents.
    if (!tabs) {
      continue
    }
    const orphans = collectOrphanEditorFileIds(fileIds, tabs, activeFileIdByWorktree[worktreeId])
    if (orphans.length > 0) {
      orphanFileIdsByWorktree.set(worktreeId, new Set(orphans))
    }
  }
  return orphanFileIdsByWorktree
}

/** Membership test for a worktree-scoped orphan map, so callers never compare ids alone. */
export function isOrphanEditorFile(
  orphanFileIdsByWorktree: ReadonlyMap<string, ReadonlySet<string>>,
  file: Pick<OpenFile, 'id' | 'worktreeId'>
): boolean {
  return orphanFileIdsByWorktree.get(file.worktreeId)?.has(file.id) === true
}
