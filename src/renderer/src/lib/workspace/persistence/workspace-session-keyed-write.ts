import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { structuredLaunchSlotSignatures } from '../../agent-session/launch/structured-agent-session-launch-persistence'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import type { WorkspaceSessionFieldEntries } from './workspace-session-acknowledged-entries'
import { sanitizeTabs } from './workspace-session-sanitized-tabs'
import { unifiedTabsWithoutStagedBrowsers } from './workspace-session-staged-browser-tabs'
import {
  worktreeTabSessionFor,
  type PersistedUnifiedTabSessionData,
  type UnifiedTabSessionCache,
  type UnifiedTabSnapshot
} from './workspace-session-unified-tabs'

/** Store fields whose changed workspace buckets a keyed write can rebuild on their own. */
export const KEYED_SESSION_FIELDS = ['tabsByWorktree', 'unifiedTabsByWorktree'] as const

export type KeyedSessionField = (typeof KEYED_SESSION_FIELDS)[number]

/** A write of only the workspace keys that changed. `fields` are the store fields it stands in for:
 *  the whole path's output for them, beyond these keys, must already be what main holds. */
export type WorkspaceSessionKeyedWrite = {
  fields: readonly KeyedSessionField[]
  entries: WorkspaceSessionFieldEntries
}

/** The keys of `worktreeIdsByField` built by the same per-workspace builders as the whole patch.
 *  Null when only a whole build can say what they save (see the unified builder's conditions). */
export function buildWorkspaceSessionKeyedWrite(
  snapshot: WorkspaceSessionSnapshot,
  worktreeIdsByField: ReadonlyMap<KeyedSessionField, ReadonlySet<string>>,
  unifiedTabSessionCache: UnifiedTabSessionCache
): WorkspaceSessionKeyedWrite | null {
  const entries: WorkspaceSessionFieldEntries = {}
  const terminalWorktreeIds = worktreeIdsByField.get('tabsByWorktree')
  if (terminalWorktreeIds) {
    const tabsByWorktree: Record<string, unknown> = {}
    for (const worktreeId of terminalWorktreeIds) {
      const tabs = snapshot.tabsByWorktree[worktreeId]
      if (!tabs) {
        return null
      }
      tabsByWorktree[worktreeId] = sanitizeTabs(tabs)
    }
    entries.tabsByWorktree = tabsByWorktree
  }
  const unifiedWorktreeIds = worktreeIdsByField.get('unifiedTabsByWorktree')
  if (unifiedWorktreeIds) {
    const tabsByWorktreeId = new Map(
      [...unifiedWorktreeIds].map((worktreeId) => {
        const tabs = snapshot.unifiedTabsByWorktree[worktreeId]
        return [worktreeId, tabs && unifiedTabsWithoutStagedBrowsers(snapshot, tabs)] as const
      })
    )
    const unified = buildPersistedUnifiedTabSessionEntries(
      snapshot,
      tabsByWorktreeId,
      unifiedTabSessionCache
    )
    if (!unified) {
      return null
    }
    Object.assign(entries, unified)
  }
  return { fields: [...worktreeIdsByField.keys()], entries }
}

function sameLaunchSlots(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [worktreeId, slots] of a) {
    if (b.get(worktreeId) !== slots) {
      return false
    }
  }
  return true
}

/** The saved tab sessions of `worktreeIds` alone, built as the whole build builds each one. Null
 *  when the whole build could differ for them: an editor tab moves in or out, launch slots changed,
 *  or a workspace has no saved session. */
export function buildPersistedUnifiedTabSessionEntries(
  snapshot: UnifiedTabSnapshot & Pick<WorkspaceSessionSnapshot, 'openFiles'>,
  tabsByWorktreeId: ReadonlyMap<string, Tab[] | undefined>,
  cache: UnifiedTabSessionCache
): PersistedUnifiedTabSessionData | null {
  const { placementTargets } = cache
  const slotsByWorktree = structuredLaunchSlotSignatures()
  if (
    !placementTargets ||
    // A file's owner can change without a unified save, which moves its editor tabs.
    cache.openFiles !== snapshot.openFiles ||
    !cache.slots ||
    !sameLaunchSlots(slotsByWorktree, cache.slots)
  ) {
    return null
  }
  let fileWorktreeIds: Map<string, string> | null = null
  const data: PersistedUnifiedTabSessionData = {
    unifiedTabs: {},
    tabGroups: {},
    tabGroupLayouts: {},
    activeGroupIdByWorktree: {}
  }
  for (const [worktreeId, liveTabs] of tabsByWorktreeId) {
    if (!liveTabs || placementTargets.has(worktreeId)) {
      return null
    }
    for (const tab of liveTabs) {
      if (!isEditorTabContentType(tab.contentType)) {
        continue
      }
      fileWorktreeIds ??= new Map(snapshot.openFiles.map((file) => [file.id, file.worktreeId]))
      const fileWorktreeId = fileWorktreeIds.get(tab.entityId)
      if (fileWorktreeId !== undefined && fileWorktreeId !== worktreeId) {
        return null
      }
    }
    const session = worktreeTabSessionFor(
      snapshot,
      worktreeId,
      liveTabs,
      snapshot.groupsByWorktree[worktreeId],
      slotsByWorktree,
      cache
    )
    if (!session) {
      return null
    }
    data.unifiedTabs[worktreeId] = session.tabs
    data.tabGroups[worktreeId] = session.groups
    data.activeGroupIdByWorktree[worktreeId] = session.activeGroupId
    data.tabGroupLayouts[worktreeId] = session.layout
  }
  return data
}
