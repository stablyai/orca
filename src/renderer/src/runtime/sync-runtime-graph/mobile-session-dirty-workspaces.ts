import type { AppState } from '@/store/types'
import type { WorktreeOperationRouteState } from '@/lib/workspace/ownership/worktree-operation-route'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import { readRecordChanges } from '@/store/record-transitions/keyed-record-change-reads'
import { getTerminalTabOwnerWorktreeIds } from '@/store/terminals/ownership/terminal-tab-owner-index'
import { hostSessionTabMappingRevision } from '../web-session-tabs-sync/state'
import { mountedTerminalTabEntries } from '../hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import type { MobileSessionPublicationInputs } from './types'

/** What one mobile publication read, so the next can tell which workspaces' inputs moved. */
export type MobileSessionPublicationSources = {
  state: AppState
  publication: MobileSessionPublicationInputs
  ambiguousTerminalTabIds: ReadonlySet<string>
}

// Every field workspace owner resolution reads; the check below fails to compile on a new one.
const OWNER_FIELDS = [
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'settings',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
] as const satisfies readonly (keyof AppState)[]
// Owner rules compare these only with the workspace they resolve, so they dirty just those two.
const ACTIVE_OWNER_FIELDS = [
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId'
] as const satisfies readonly (keyof AppState)[]
type UntrackedOwnerField = Exclude<
  keyof WorktreeOperationRouteState | keyof WorktreeRuntimeOwnerState,
  (typeof OWNER_FIELDS)[number] | (typeof ACTIVE_OWNER_FIELDS)[number]
>
const OWNER_FIELDS_COMPLETE: [UntrackedOwnerField] extends [never] ? true : never = true
void OWNER_FIELDS_COMPLETE

// Records keyed by terminal tab id; a write dirties only the workspaces holding that tab.
const SEAM_TAB_KEYED_FIELDS = [
  'terminalLayoutsByTabId',
  'runtimePaneTitlesByTabId',
  'nativeChatLaunchDraftByTabId'
] as const satisfies readonly (keyof AppState)[]

const scratchSources: unknown[] = []

/** Workspace-keyed sources, compared per workspace without building its inputs. */
export function readMobileSessionWorkspaceSources(
  state: AppState,
  worktreeId: string,
  publication: MobileSessionPublicationInputs,
  crossPlacedWorkspaces: ReadonlySet<string>,
  into: unknown[] = []
): unknown[] {
  const indexes = publication.openFileIndexes
  into.length = 0
  into.push(
    state.tabsByWorktree[worktreeId],
    state.unifiedTabsByWorktree[worktreeId],
    state.groupsByWorktree[worktreeId],
    state.tabBarOrderByWorktree[worktreeId],
    state.activeGroupIdByWorktree[worktreeId],
    state.layoutByWorktree?.[worktreeId],
    publication.browserTabsByWorktree[worktreeId],
    state.activeFileIdByWorktree?.[worktreeId],
    state.activeTabTypeByWorktree?.[worktreeId],
    state.activeBrowserTabIdByWorktree?.[worktreeId],
    indexes.byWorktreeAndId.get(worktreeId),
    indexes.idsByWorktree.get(worktreeId),
    crossPlacedWorkspaces.has(worktreeId),
    hostSessionTabMappingRevision(worktreeId)
  )
  return into
}

export function mobileSessionWorkspaceSourcesUnchanged(
  previous: readonly unknown[],
  state: AppState,
  worktreeId: string,
  publication: MobileSessionPublicationInputs,
  crossPlacedWorkspaces: ReadonlySet<string>
): boolean {
  const next = readMobileSessionWorkspaceSources(
    state,
    worktreeId,
    publication,
    crossPlacedWorkspaces,
    scratchSources
  )
  return next.length === previous.length && next.every((value, index) => value === previous[index])
}

/**
 * Workspaces whose inputs may differ from the previous publication beyond their own keyed
 * sources, or `all` when a shared input changed or a write left no keyed provenance.
 */
export function collectDirtyMobileSessionWorkspaces(
  previous: MobileSessionPublicationSources | null,
  next: MobileSessionPublicationSources
): ReadonlySet<string> | 'all' {
  if (!previous) {
    return 'all'
  }
  const before = previous.state
  const after = next.state
  if (
    previous.publication.terminalTheme !== next.publication.terminalTheme ||
    previous.publication.generatedTitlesEnabled !== next.publication.generatedTitlesEnabled ||
    !sameMembers(previous.ambiguousTerminalTabIds, next.ambiguousTerminalTabIds) ||
    OWNER_FIELDS.some((field) => before[field] !== after[field])
  ) {
    return 'all'
  }
  const dirty = new Set<string>()
  // Mounted panes are read live from the pane managers, so their workspaces always re-capture.
  for (const [, registered] of mountedTerminalTabEntries()) {
    dirty.add(registered.worktreeId)
  }
  if (ACTIVE_OWNER_FIELDS.some((field) => before[field] !== after[field])) {
    addPresent(dirty, before.activeWorktreeId)
    addPresent(dirty, after.activeWorktreeId)
  }
  if (before.activeTabId !== after.activeTabId) {
    for (const tabId of [before.activeTabId, after.activeTabId]) {
      if (tabId) {
        addTerminalTabOwners(dirty, after, tabId)
      }
    }
  }
  for (const field of SEAM_TAB_KEYED_FIELDS) {
    const beforeRecord = before[field]
    const afterRecord = after[field]
    if (beforeRecord === afterRecord) {
      continue
    }
    const changes =
      beforeRecord && afterRecord ? readRecordChanges(afterRecord, beforeRecord) : undefined
    if (changes?.kind !== 'addressed') {
      return 'all'
    }
    for (const tabId of changes.keys) {
      addTerminalTabOwners(dirty, after, tabId)
    }
  }
  if (
    before.browserPagesByWorkspace !== after.browserPagesByWorkspace ||
    before.browserCertificateFailuresByPageId !== after.browserCertificateFailuresByPageId
  ) {
    for (const [worktreeId, workspaces] of Object.entries(next.publication.browserTabsByWorktree)) {
      if (workspaces.length > 0) {
        dirty.add(worktreeId)
      }
    }
  }
  // The global active file and tab type only reach workspaces with an open file.
  if (
    previous.publication.editorDraftVersionByFileId !==
      next.publication.editorDraftVersionByFileId ||
    before.activeFileId !== after.activeFileId ||
    before.activeTabType !== after.activeTabType
  ) {
    for (const worktreeId of next.publication.openFileIndexes.idsByWorktree.keys()) {
      dirty.add(worktreeId)
    }
  }
  return dirty
}

function addTerminalTabOwners(dirty: Set<string>, state: AppState, tabId: string): void {
  for (const worktreeId of getTerminalTabOwnerWorktreeIds(state.tabsByWorktree, tabId)) {
    dirty.add(worktreeId)
  }
}

function addPresent(dirty: Set<string>, worktreeId: string | null | undefined): void {
  if (worktreeId) {
    dirty.add(worktreeId)
  }
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) {
    return true
  }
  if (a.size !== b.size) {
    return false
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false
    }
  }
  return true
}
