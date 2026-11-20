import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { getOpenFileExecutionHostId } from '@/lib/workspace/ownership/unified-tab-host-ownership'
import { openFileIndex } from '@/store/slices/editor/tabs/workspace-editor-files'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type { SessionRelevantField, WorkspaceSessionSnapshot } from './workspace-session'
import type { WorkspaceSessionFieldEntries } from './workspace-session-acknowledged-entries'
import { sanitizeTabs } from './workspace-session-sanitized-tabs'
import { unifiedTabsWithoutStagedBrowsers } from './workspace-session-staged-browser-tabs'
import { launchSlotsForSave, sameLaunchSlots } from './workspace-session-launch-slots'
import {
  buildUnifiedTabSessionData,
  type PersistedUnifiedTabSessionData,
  type UnifiedTabSessionCache
} from './workspace-session-unified-tabs'
import type { TitleChangeScope } from './session-write-tab-changes'

/** A write of only the workspace keys that changed. `fields` are the store fields it stands in for:
 *  the whole path's output for them, beyond these keys, must already be what main holds. */
export type WorkspaceSessionKeyedWrite = {
  fields: readonly SessionRelevantField[]
  entries: WorkspaceSessionFieldEntries
}

/** The changed keys of `scopes`, built by the same per-workspace builders as the whole patch.
 *  Null when only a whole build can say what they save (see the unified builder's conditions). */
export function buildWorkspaceSessionKeyedWrite(
  snapshot: WorkspaceSessionSnapshot,
  scopes: ReadonlyMap<SessionRelevantField, TitleChangeScope>,
  unifiedTabSessionCache: UnifiedTabSessionCache
): WorkspaceSessionKeyedWrite | null {
  const entries: WorkspaceSessionFieldEntries = {}
  for (const [field, scope] of scopes) {
    if (scope.tabs === 'terminal') {
      const sanitized: Record<string, unknown> = {}
      for (const worktreeId of scope.worktreeIds) {
        const tabs = snapshot.tabsByWorktree[worktreeId]
        if (!tabs) {
          return null
        }
        sanitized[worktreeId] = sanitizeTabs(tabs)
      }
      // Terminal tabs save under their store field's own name.
      entries[field] = sanitized
      continue
    }
    const unified = buildPersistedUnifiedTabSessionEntries(
      snapshot,
      scope.worktreeIds,
      unifiedTabSessionCache
    )
    if (!unified) {
      return null
    }
    Object.assign(entries, unified)
  }
  return { fields: [...scopes.keys()], entries }
}

/** Whether editor placement reads the same from both lists: which files exist, their owners, modes
 *  and the host a moved editor tab is saved under. Typing or saving changes none of these. */
function sameFilePlacements(
  previous: readonly OpenFile[] | undefined | null,
  next: readonly OpenFile[] | undefined
): boolean {
  if (previous === next) {
    return true
  }
  if (!previous || !next || previous.length !== next.length) {
    return false
  }
  return next.every((file, index) => {
    const before = previous[index]
    return (
      before !== undefined &&
      before.id === file.id &&
      before.worktreeId === file.worktreeId &&
      before.mode === file.mode &&
      getOpenFileExecutionHostId(before) === getOpenFileExecutionHostId(file)
    )
  })
}

/** The saved tab sessions of `worktreeIds` alone, built by the whole build's own loop. Null when
 *  the whole build could differ for them: an editor tab moves in or out, open files or launch slots
 *  changed since that build, or a workspace has no saved session. */
function buildPersistedUnifiedTabSessionEntries(
  snapshot: WorkspaceSessionSnapshot,
  worktreeIds: ReadonlySet<string>,
  cache: UnifiedTabSessionCache
): PersistedUnifiedTabSessionData | null {
  const { placementTargets } = cache
  if (
    !placementTargets ||
    // A file's owner can change without a unified save, which moves its editor tabs.
    !sameFilePlacements(cache.placementFiles, snapshot.openFiles) ||
    !cache.slots
  ) {
    return null
  }
  // Proven equal for placement: later saves with this same list skip the comparison.
  cache.placementFiles = snapshot.openFiles
  const sourceTabs: Record<string, Tab[]> = {}
  for (const worktreeId of worktreeIds) {
    const liveTabs = snapshot.unifiedTabsByWorktree[worktreeId]
    if (!liveTabs || placementTargets.has(worktreeId)) {
      return null
    }
    for (const tab of liveTabs) {
      if (!isEditorTabContentType(tab.contentType)) {
        continue
      }
      const fileWorktreeId = openFileIndex(snapshot.openFiles).get(tab.entityId)?.worktreeId
      if (fileWorktreeId !== undefined && fileWorktreeId !== worktreeId) {
        return null
      }
    }
    sourceTabs[worktreeId] = unifiedTabsWithoutStagedBrowsers(snapshot, liveTabs)
  }
  // Read after the per-workspace checks, and shared with a whole fallback in the same save.
  if (!sameLaunchSlots(launchSlotsForSave(cache), cache.slots)) {
    return null
  }
  const data = buildUnifiedTabSessionData(
    snapshot,
    sourceTabs,
    snapshot.groupsByWorktree,
    cache,
    worktreeIds
  )
  const { unifiedTabs } = data
  for (const worktreeId of worktreeIds) {
    if (!unifiedTabs || !Object.hasOwn(unifiedTabs, worktreeId)) {
      return null
    }
  }
  return data
}
