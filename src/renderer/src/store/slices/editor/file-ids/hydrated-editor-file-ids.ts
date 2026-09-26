import type { AppState } from '../../../types'
import type { Tab, TabGroup } from '../../../../../../shared/tab-types'
import type { PersistedOpenFile } from '../../../../../../shared/workspace-session-state-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import type { OpenFile } from '../types/open-file'
import { isEditorTabContentType } from '../tabs/editor-tab-content-type'
import { dedupeEditorTabsWithinGroups } from '../../tab-group-state'
import { buildOwnedEditorFileId } from './editor-file-ids'
import { runtimeOwnerKey } from './editor-document-identity'

export function shouldHydrateWithOwnedEditorFileId(
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): boolean {
  return (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID || runtimeOwnerKey(runtimeEnvironmentId) !== null
  )
}

export function addEditorFileIdMigration(
  migrationsByWorktree: Record<string, Map<string, string>>,
  worktreeId: string,
  from: string,
  to: string
): void {
  if (from === to) {
    return
  }
  const migrations =
    migrationsByWorktree[worktreeId] ?? (migrationsByWorktree[worktreeId] = new Map())
  migrations.set(from, to)
}

export type LegacyHydratedEditorFile = Pick<
  OpenFile,
  'id' | 'filePath' | 'worktreeId' | 'runtimeEnvironmentId' | 'markdownPreviewSourceFileId'
>

export class LegacyHydratedEditorFileIndex {
  private readonly filesByPath = new Map<string, Map<string, string>>()
  private readonly ownersById = new Map<string, Set<string>>()

  private ownerKey(worktreeId: string, runtimeEnvironmentId: string | null | undefined): string {
    return JSON.stringify([worktreeId, runtimeOwnerKey(runtimeEnvironmentId)])
  }

  hasOwner(file: PersistedOpenFile, worktreeId: string): boolean {
    return (
      this.filesByPath
        .get(file.filePath)
        ?.has(this.ownerKey(worktreeId, file.runtimeEnvironmentId)) ?? false
    )
  }

  resolve(file: PersistedOpenFile, worktreeId: string): string {
    const owner = this.ownerKey(worktreeId, file.runtimeEnvironmentId)
    const existing = this.filesByPath.get(file.filePath)?.get(owner)
    if (existing !== undefined) {
      return existing
    }
    const occupied = this.ownersById.get(file.filePath)
    return occupied && (occupied.size > 1 || !occupied.has(owner))
      ? buildOwnedEditorFileId(file.filePath, worktreeId, file.runtimeEnvironmentId)
      : file.filePath
  }

  add(file: LegacyHydratedEditorFile): void {
    const owner = this.ownerKey(file.worktreeId, file.runtimeEnvironmentId)
    let files = this.filesByPath.get(file.filePath)
    if (!files) {
      files = new Map()
      this.filesByPath.set(file.filePath, files)
    }
    if (!files.has(owner)) {
      files.set(owner, file.id)
    }
    this.addIdOwner(file.id, owner)
    if (file.markdownPreviewSourceFileId !== undefined) {
      this.addIdOwner(file.markdownPreviewSourceFileId, owner)
    }
  }

  private addIdOwner(id: string, owner: string): void {
    let owners = this.ownersById.get(id)
    if (!owners) {
      owners = new Set()
      this.ownersById.set(id, owners)
    }
    owners.add(owner)
  }
}

export function migrateEditorFileId(
  migrationsByWorktree: Record<string, Map<string, string>>,
  worktreeId: string,
  fileId: string | null | undefined
): string | null {
  if (!fileId) {
    return null
  }
  return migrationsByWorktree[worktreeId]?.get(fileId) ?? fileId
}

export function dedupeEditorTabOrder(tabIds: string[], validTabIds: Set<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const tabId of tabIds) {
    if (!validTabIds.has(tabId) || seen.has(tabId)) {
      continue
    }
    seen.add(tabId)
    result.push(tabId)
  }
  return result
}

export function areStringArraysEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

/**
 * Move a dropped twin's pin and labelling onto the tab the dedupe keeps. The dedupe survivor is
 * simply the first tab in array order, so a pinned runtime-owned twin merged into an unpinned local
 * one would come back unpinned — undoing the protection that keeps a pinned sibling open.
 */
function carryEditorTwinDecorationOntoSurvivor(tabs: Tab[]): Tab[] {
  const survivorIndexByGroupAndEntity = new Map<string, number>()
  let merged: Tab[] | null = null
  tabs.forEach((tab, index) => {
    if (tab.contentType !== 'editor') {
      return
    }
    const key = `${tab.groupId}\u0000${tab.entityId}`
    const survivorIndex = survivorIndexByGroupAndEntity.get(key)
    if (survivorIndex === undefined) {
      survivorIndexByGroupAndEntity.set(key, index)
      return
    }
    const survivor = merged?.[survivorIndex] ?? tabs[survivorIndex]
    const decorated: Tab = {
      ...survivor,
      ...(tab.isPinned === true && survivor.isPinned !== true ? { isPinned: true } : {}),
      ...(survivor.customLabel == null && tab.customLabel != null
        ? { customLabel: tab.customLabel }
        : {}),
      ...(survivor.color == null && tab.color != null ? { color: tab.color } : {})
    }
    if (
      decorated.isPinned === survivor.isPinned &&
      decorated.customLabel === survivor.customLabel &&
      decorated.color === survivor.color
    ) {
      return
    }
    merged ??= [...tabs]
    merged[survivorIndex] = decorated
  })
  return merged ?? tabs
}

export function migrateHydratedEditorTabsAndGroups(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'>,
  migrationsByWorktree: Record<string, Map<string, string>>
): Partial<Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'>> {
  let tabsChanged = false
  let groupsChanged = false
  const nextUnifiedTabsByWorktree: Record<string, Tab[]> = { ...state.unifiedTabsByWorktree }
  const tabIdMigrationsByWorktree: Record<string, Map<string, string>> = {}
  const dedupeAliasesByWorktree: Record<string, Map<string, Map<string, string>>> = {}

  for (const [worktreeId, idMigrations] of Object.entries(migrationsByWorktree)) {
    const tabs = state.unifiedTabsByWorktree[worktreeId]
    if (!tabs) {
      continue
    }
    const tabIdMigrations = new Map<string, string>()
    const nextTabs = tabs.map((tab) => {
      // Why: widened for the shared live-move rekey — a move retargets every editor-family tab (diff/conflict-review/check-details), not only plain 'editor'.
      if (!isEditorTabContentType(tab.contentType)) {
        return tab
      }
      const nextId = idMigrations.get(tab.id) ?? tab.id
      const nextEntityId = idMigrations.get(tab.entityId) ?? tab.entityId
      if (nextId === tab.id && nextEntityId === tab.entityId) {
        return tab
      }
      tabsChanged = true
      if (nextId !== tab.id) {
        tabIdMigrations.set(tab.id, nextId)
      }
      return { ...tab, id: nextId, entityId: nextEntityId }
    })
    if (tabIdMigrations.size > 0) {
      tabIdMigrationsByWorktree[worktreeId] = tabIdMigrations
    }
    // Why here and not in tabs hydration: that dedupe ran before this rewrite, so a local tab and a
    // runtime-owned tab for one path were still two entities. Redirecting both onto the survivor's
    // id makes them one document in one group, and a repeated React key leaves a ghost row mounted.
    const deduped = dedupeEditorTabsWithinGroups(carryEditorTwinDecorationOntoSurvivor(nextTabs))
    if (deduped.tabs.length !== nextTabs.length) {
      tabsChanged = true
      dedupeAliasesByWorktree[worktreeId] = deduped.tabIdAliasesByGroup
    }
    nextUnifiedTabsByWorktree[worktreeId] = deduped.tabs
  }

  const nextGroupsByWorktree: Record<string, TabGroup[]> = { ...state.groupsByWorktree }
  const repointedWorktreeIds = new Set([
    ...Object.keys(tabIdMigrationsByWorktree),
    ...Object.keys(dedupeAliasesByWorktree)
  ])
  for (const worktreeId of repointedWorktreeIds) {
    const groups = state.groupsByWorktree[worktreeId]
    if (!groups) {
      continue
    }
    const tabIdMigrations = tabIdMigrationsByWorktree[worktreeId]
    const dedupeAliasesByGroup = dedupeAliasesByWorktree[worktreeId]
    const validTabIds = new Set((nextUnifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
    nextGroupsByWorktree[worktreeId] = groups.map((group) => {
      const dedupeAliases = dedupeAliasesByGroup?.get(group.id)
      // Why this order: the dedupe ran on already-migrated tabs, so its aliases key on migrated ids.
      const canonicalTabId = (tabId: string): string => {
        const migrated = tabIdMigrations?.get(tabId) ?? tabId
        return dedupeAliases?.get(migrated) ?? migrated
      }
      const tabOrder = dedupeEditorTabOrder(group.tabOrder.map(canonicalTabId), validTabIds)
      const activeTabId = group.activeTabId ? canonicalTabId(group.activeTabId) : null
      const validActiveTabId = activeTabId && validTabIds.has(activeTabId) ? activeTabId : null
      const recentTabIds = group.recentTabIds
        ? dedupeEditorTabOrder(group.recentTabIds.map(canonicalTabId), validTabIds)
        : group.recentTabIds
      if (
        validActiveTabId === group.activeTabId &&
        areStringArraysEqual(tabOrder, group.tabOrder) &&
        areStringArraysEqual(recentTabIds, group.recentTabIds)
      ) {
        return group
      }
      groupsChanged = true
      return {
        ...group,
        activeTabId: validActiveTabId,
        tabOrder,
        recentTabIds
      }
    })
  }

  return {
    ...(tabsChanged ? { unifiedTabsByWorktree: nextUnifiedTabsByWorktree } : {}),
    ...(groupsChanged ? { groupsByWorktree: nextGroupsByWorktree } : {})
  }
}
