import type { AppState } from '../../../types'
import type { WorkspaceRemovalScope, WorkspaceRemovalSource } from './workspace-removal-scope'
import { rawWorkspaceState } from '../../../workspace-source-state'
import { selectWorkspaceByHostTarget } from '../../../workspace-record-selectors'
import { collectPtyIdsForTab } from '../../terminal-tab-retirement'
import { workspaceTabCandidates } from '@/lib/structured-chat-tab-index'
import { indexedOpenFileById } from '@/runtime/web-session-tabs-sync/mirrored-editor-file-identity'
import { getOpenFileExecutionHostId } from '@/lib/unified-tab-host-ownership'
import {
  ImmutableInputCache,
  absentImmutableInput
} from '../../../../../../shared/immutable-input-cache'
import { assertWorktreeOperationGenerationSnapshotCurrent } from '@/lib/worktree-operation-generation'
const changedOwner = () => new Error('The workspace owner changed during removal. Try again.')

/** Absence after our accepted removal is expected; a replacement or changed transport is not. */
export function workspaceRemovalScopeIsCurrent(
  state: AppState,
  scope: WorkspaceRemovalScope
): boolean {
  try {
    if (scope.generation) {
      const generation = scope.generation
      assertWorktreeOperationGenerationSnapshotCurrent(
        () => state,
        scope.target.id,
        generation,
        changedOwner,
        () => generation.route
      )
    }
    const row = selectWorkspaceByHostTarget(state, scope.target)
    return (
      !row ||
      Boolean(
        scope.row &&
        row.instanceId === scope.row.instanceId &&
        JSON.stringify(row.identity) === JSON.stringify(scope.row.identity) &&
        row.hostId === scope.row.hostId &&
        row.runtimeOwnerEnvironmentId === scope.row.runtimeOwnerEnvironmentId
      )
    )
  } catch {
    return false
  }
}
export function assertWorkspaceRemovalScopeCurrent(
  state: AppState,
  scope: WorkspaceRemovalScope
): void {
  if (!workspaceRemovalScopeIsCurrent(state, scope)) {
    throw changedOwner()
  }
}

function sourceOwnerIsCurrent(state: AppState, captured: WorkspaceRemovalSource): boolean {
  const row = selectWorkspaceByHostTarget(state, {
    id: captured.source.workspaceId,
    hostId: captured.source.hostId
  })
  return (
    !row ||
    Boolean(
      captured.row &&
      row.instanceId === captured.row.instanceId &&
      JSON.stringify(row.identity) === JSON.stringify(captured.row.identity) &&
      row.hostId === captured.row.hostId &&
      row.runtimeOwnerEnvironmentId === captured.row.runtimeOwnerEnvironmentId
    )
  )
}

class ResourceRows<Row extends { id: string }> {
  private readonly indexes = new WeakMap<readonly Row[], Map<string, Row>>()
  get(rows: readonly Row[] | undefined, id: string): Row | undefined {
    if (!rows) {
      return undefined
    }
    let index = this.indexes.get(rows)
    if (!index) {
      index = new Map(rows.map((row) => [row.id, row]))
      this.indexes.set(rows, index)
    }
    return index.get(id)
  }
}
const terminalRows = new ResourceRows<WorkspaceRemovalSource['terminals'][number]>()
const browserRows = new ResourceRows<WorkspaceRemovalSource['browsers'][number]>()
const sourceIndexes = new WeakMap<WorkspaceRemovalScope, Map<string, WorkspaceRemovalSource>>()
function capturedSource(scope: WorkspaceRemovalScope, id: string) {
  let index = sourceIndexes.get(scope)
  if (!index) {
    index = new Map(scope.sources.map((entry) => [entry.source.workspaceId, entry]))
    sourceIndexes.set(scope, index)
  }
  return index.get(id)
}
function tabIsCurrent(state: AppState, old: WorkspaceRemovalSource['tabs'][number]): boolean {
  const tab = workspaceTabCandidates(state.unifiedTabsByWorktree[old.worktreeId], old.id).find(
    (row) => row.id === old.id
  )
  return (
    !tab ||
    (tab.entityId === old.entityId &&
      tab.contentType === old.contentType &&
      tab.executionHostId === old.executionHostId)
  )
}
const capturedPtys = new WeakMap<WorkspaceRemovalSource, Map<string, Set<string>>>()
function ptysAreCurrent(
  state: AppState,
  captured: WorkspaceRemovalSource,
  id: string,
  ptyId: string | null | undefined
): boolean {
  let index = capturedPtys.get(captured)
  if (!index) {
    index = new Map([...captured.ptys].map(([id, ptys]) => [id, new Set(ptys)]))
    capturedPtys.set(captured, index)
  }
  return collectPtyIdsForTab(state, id, ptyId).every((pty) => index.get(id)?.has(pty))
}
function browserIsCurrent(
  state: AppState,
  captured: WorkspaceRemovalSource,
  old: WorkspaceRemovalSource['browsers'][number]
): boolean {
  const tab = browserRows.get(state.browserTabsByWorktree[captured.source.workspaceId], old.id)
  return (
    (!tab ||
      (tab.worktreeId === old.worktreeId &&
        tab.createdAt === old.createdAt &&
        tab.sessionProfileId === old.sessionProfileId &&
        tab.sessionPartition === old.sessionPartition)) &&
    workspaceTabCandidates(captured.tabs, old.id)
      .filter((tab) => tab.contentType === 'browser' && tab.entityId === old.id)
      .every((tab) => tabIsCurrent(state, tab))
  )
}

/** Per-browser callbacks validate only their covered backing resource, including after owner awaits. */
export function workspaceRemovalBrowserIsCurrent(
  view: AppState,
  scope: WorkspaceRemovalScope,
  captured: WorkspaceRemovalSource,
  browser: WorkspaceRemovalSource['browsers'][number]
): boolean {
  const state = rawWorkspaceState(view)
  return (
    workspaceRemovalScopeIsCurrent(state, scope) &&
    sourceOwnerIsCurrent(state, captured) &&
    browserIsCurrent(state, captured, browser)
  )
}
const eligibleSources = new ImmutableInputCache<WorkspaceRemovalSource>()
/** Repeated phases share relevant immutable inputs; no whole-state or last-input strong root. */
export function currentWorkspaceRemovalSource(
  view: AppState,
  scope: WorkspaceRemovalScope,
  captured: WorkspaceRemovalSource
): WorkspaceRemovalSource | undefined {
  const state = rawWorkspaceState(view)
  if (!workspaceRemovalScopeIsCurrent(state, scope) || !sourceOwnerIsCurrent(state, captured)) {
    return undefined
  }
  const id = captured.source.workspaceId
  const inputs = [
    captured,
    state.unifiedTabsByWorktree[id] ?? absentImmutableInput,
    state.tabsByWorktree[id] ?? absentImmutableInput,
    state.browserTabsByWorktree[id] ?? absentImmutableInput,
    state.openFiles,
    state.ptyIdsByTabId,
    state.terminalLayoutsByTabId,
    state.lastKnownRelayPtyIdByTabId,
    state.deferredSshSessionIdsByTabId,
    state.pendingReconnectPtyIdByTabId
  ]
  const known = eligibleSources.get(inputs, 'source')
  if (known) {
    return known
  }
  const matchingTabs = captured.tabs.filter((tab) => tabIsCurrent(state, tab))
  const terminals = captured.terminals.filter((old) => {
    const tab = terminalRows.get(state.tabsByWorktree[id], old.id)
    return (
      !tab ||
      (old.generation === tab.generation &&
        (!tab.ptyId || old.ptyId === tab.ptyId) &&
        ptysAreCurrent(state, captured, tab.id, tab.ptyId))
    )
  })
  const files = captured.files.filter((old) => {
    const file = indexedOpenFileById(state.openFiles, old.id)
    return (
      !file ||
      (old.worktreeId === file.worktreeId &&
        old.filePath === file.filePath &&
        getOpenFileExecutionHostId(old) === getOpenFileExecutionHostId(file))
    )
  })
  const browsers = captured.browsers.filter((old) => browserIsCurrent(state, captured, old))
  const terminalIds = new Set(terminals.map((tab) => tab.id)),
    fileIds = new Set(files.map((file) => file.id)),
    browserIds = new Set(browsers.map((tab) => tab.id))
  const tabs = matchingTabs.filter((tab) => {
    if (tab.contentType === 'terminal') {
      return terminalRows.get(state.tabsByWorktree[id], tab.entityId)
        ? terminalIds.has(tab.entityId)
        : ptysAreCurrent(state, captured, tab.entityId, null)
    }
    if (tab.contentType === 'editor' && indexedOpenFileById(state.openFiles, tab.entityId)) {
      return fileIds.has(tab.entityId)
    }
    if (tab.contentType === 'browser') {
      return browserIds.has(tab.entityId)
    }
    return true
  })
  const intersection = (a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> =>
    new Set([...a].filter((id) => b.has(id)))
  const result = {
    ...captured,
    tabs,
    terminals,
    files,
    browsers,
    removed: {
      terminalTabIds: intersection(
        captured.removed.terminalTabIds,
        new Set([
          ...terminalIds,
          ...tabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
        ])
      ),
      fileIds: intersection(captured.removed.fileIds, fileIds),
      browserTabIds: intersection(captured.removed.browserTabIds, browserIds),
      otherTabIds: intersection(captured.removed.otherTabIds, new Set(tabs.map((tab) => tab.id))),
      conversationIds: new Set(
        tabs.filter((tab) => tab.contentType === 'agent-session').map((tab) => tab.entityId)
      ),
      mixedTabPtyIds: captured.removed.mixedTabPtyIds
    }
  }
  eligibleSources.set(inputs, 'source', result)
  return result
}
/** Only captured resource identities still on the accepted physical owner can be retired. */
export function currentWorkspaceRemovalSources(
  view: AppState,
  scope: WorkspaceRemovalScope
): WorkspaceRemovalSource[] {
  return scope.sources.flatMap((source) => {
    const current = currentWorkspaceRemovalSource(view, scope, source)
    return current ? [current] : []
  })
}

export function workspaceRemovalTabIsCurrent(
  view: AppState,
  scope: WorkspaceRemovalScope,
  captured: WorkspaceRemovalSource['tabs'][number]
): boolean {
  if (!workspaceRemovalScopeIsCurrent(view, scope)) {
    return false
  }
  const state = rawWorkspaceState(view)
  const source = capturedSource(scope, captured.worktreeId)
  if (!source || !sourceOwnerIsCurrent(state, source)) {
    return false
  }
  const live = workspaceTabCandidates(
    state.unifiedTabsByWorktree[captured.worktreeId],
    captured.id
  ).find((tab) => tab.id === captured.id)
  return (
    !live ||
    (live.entityId === captured.entityId &&
      live.contentType === captured.contentType &&
      live.executionHostId === captured.executionHostId)
  )
}
