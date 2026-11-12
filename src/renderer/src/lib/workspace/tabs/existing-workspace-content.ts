import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { getFolderWorkspaceWorktree } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { resolveQualifiedIndexedFolderWorkspace } from '@/store/folder-workspaces/folder-workspace-record-index'
import { getIndexedWorktreesById } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { findIndexedDetectedWorktreeRows } from '../ownership/worktree-runtime-owner-index'
import { dedupePaletteWorktrees } from '../search/palette-repo-resolution'

import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { detectedWorktreeChangesAreIrrelevant } from '../ownership/detected-worktree-row-changes'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

type ContentBuckets = Readonly<Record<string, readonly unknown[]>>
export type ExistingWorkspaceContent = {
  tabsByWorktree?: ContentBuckets
  unifiedTabsByWorktree?: ContentBuckets
  browserTabsByWorktree?: ContentBuckets
}

/** Editor placement belongs to unified tabs, not their possibly unreferenced backing files. */
export function getExistingWorkspaceContentIds(state: ExistingWorkspaceContent): string[] {
  const ids = new Set<string>()
  for (const buckets of [
    state.tabsByWorktree,
    state.unifiedTabsByWorktree,
    state.browserTabsByWorktree
  ]) {
    for (const [id, content] of Object.entries(buckets ?? {})) {
      if (content.length) {
        ids.add(id)
      }
    }
  }
  return [...ids]
}

function bucketMembershipChanged(previous: ContentBuckets, next: ContentBuckets): boolean {
  const changes = readRecordChanges(next, previous)
  if (!changes) {
    return false
  }
  return (
    changes.kind === 'full-resync' ||
    [...changes.keys].some((id) => !!previous[id]?.length !== !!next[id]?.length)
  )
}

/** Nonempty membership belongs to the bucket, not the number or metadata of tabs in it. */
export function createExistingWorkspaceContentSelector() {
  let previous: Required<ExistingWorkspaceContent> | undefined
  let ids: string[] = []
  return (state: Required<ExistingWorkspaceContent>): string[] => {
    const changed =
      !previous ||
      bucketMembershipChanged(previous.tabsByWorktree, state.tabsByWorktree) ||
      bucketMembershipChanged(previous.unifiedTabsByWorktree, state.unifiedTabsByWorktree) ||
      bucketMembershipChanged(previous.browserTabsByWorktree, state.browserTabsByWorktree)
    previous = {
      tabsByWorktree: state.tabsByWorktree,
      unifiedTabsByWorktree: state.unifiedTabsByWorktree,
      browserTabsByWorktree: state.browserTabsByWorktree
    }
    if (changed) {
      const next = getExistingWorkspaceContentIds(previous)
      if (next.length !== ids.length || next.some((id, index) => id !== ids[index])) {
        ids = next
      }
    }
    return ids
  }
}

export type ExistingContentWorktreeState = Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'> &
  Partial<Pick<AppState, 'detectedWorktreesByRepo' | 'repos' | 'projectGroups'>> &
  ExistingWorkspaceContent

/** Resolve only actual content addresses; this is never a list of new workspace destinations. */
export function getExistingContentWorktrees(
  state: ExistingContentWorktreeState,
  workspaceIds: readonly string[] = getExistingWorkspaceContentIds(state)
): Worktree[] {
  const rows: Worktree[] = []
  for (const id of workspaceIds) {
    for (const row of findIndexedDetectedWorktreeRows(selectDetectedWorktreesByRepo(state), id)) {
      if (!row.isArchived) {
        rows.push(row)
      }
    }
    // Listed metadata wins a duplicate publication, as in the ordinary known-row lookup.
    rows.push(...getIndexedWorktreesById(selectWorktreesByRepo(state), id))
  }
  const ids = new Set(workspaceIds)
  for (const folder of selectFolderWorkspaces(state)) {
    if (!ids.has(folderWorkspaceKey(folder.id))) {
      continue
    }
    const result = resolveQualifiedIndexedFolderWorkspace(state, folder.id)
    rows.push(
      getFolderWorkspaceWorktree(
        folder,
        result.kind === 'selected' && result.value.workspace === folder ? result.value : undefined
      )
    )
  }
  return dedupePaletteWorktrees(rows)
}

/** Subscribe the mount owner to ID/path changes, not raw metadata-only publications. */
export function createExistingContentSurfaceSelector() {
  const selectContentIds = createExistingWorkspaceContentSelector()
  let previousDetected: AppState['detectedWorktreesByRepo'] | undefined
  let previousIds: readonly string[] | undefined
  let contentIds: ReadonlySet<string> = new Set()
  let surfaces: Pick<Worktree, 'id' | 'path'>[] = []
  return (
    state: Required<ExistingWorkspaceContent> & Pick<AppState, 'detectedWorktreesByRepo'>
  ) => {
    const ids = selectContentIds(state)
    const detected = selectDetectedWorktreesByRepo(state)
    const unchanged =
      ids === previousIds &&
      detectedWorktreeChangesAreIrrelevant(previousDetected, detected, (before, after) => {
        if (!before || !after) {
          return false
        }
        return (
          (!contentIds.has(before.id) && !contentIds.has(after.id)) ||
          (before.id === after.id &&
            before.path === after.path &&
            before.hostId === after.hostId &&
            before.runtimeOwnerEnvironmentId === after.runtimeOwnerEnvironmentId &&
            before.isArchived === after.isArchived)
        )
      })
    if (ids !== previousIds) {
      contentIds = new Set(ids)
    }
    previousIds = ids
    previousDetected = detected
    if (unchanged) {
      return surfaces
    }
    const paths = new Map<string, string>()
    for (const row of getExistingContentWorktrees(
      {
        worktreesByRepo: {},
        detectedWorktreesByRepo: detected,
        folderWorkspaces: []
      },
      ids
    )) {
      // Git IDs encode paths; host twins share one mount surface, never an execution owner.
      if (!paths.has(row.id)) {
        paths.set(row.id, row.path)
      }
    }
    const next = Array.from(paths, ([id, path]) => ({ id, path }))
    if (
      next.length !== surfaces.length ||
      next.some((row, index) => row.id !== surfaces[index].id || row.path !== surfaces[index].path)
    ) {
      surfaces = next
    }
    return surfaces
  }
}
