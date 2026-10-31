import type { AppState } from '../../../types'
import type { WorkspaceRemovalScope, WorkspaceRemovalSource } from './workspace-removal-scope'
import { rawWorkspaceState } from '../../../workspace-source-state'
import { selectWorkspaceByHostTarget } from '../../../workspace-record-selectors'
import { collectPtyIdsForTab } from '../../terminal-tab-retirement'
import { workspaceTabCandidates } from '@/lib/structured-chat-tab-index'
import { indexedOpenFileById } from '@/runtime/web-session-tabs-sync/mirrored-editor-file-identity'
import { getOpenFileExecutionHostId } from '@/lib/unified-tab-host-ownership'
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

/** Only captured resource identities still on the accepted physical owner can be retired. */
export function currentWorkspaceRemovalSources(
  view: AppState,
  scope: WorkspaceRemovalScope
): WorkspaceRemovalSource[] {
  const state = rawWorkspaceState(view)
  if (!workspaceRemovalScopeIsCurrent(state, scope)) {
    return []
  }
  return scope.sources
    .filter((captured) => sourceOwnerIsCurrent(state, captured))
    .map((captured) => {
      const id = captured.source.workspaceId
      const liveTabs = new Map((state.unifiedTabsByWorktree[id] ?? []).map((tab) => [tab.id, tab]))
      const tabs = captured.tabs.filter((old) => {
        const tab = liveTabs.get(old.id)
        return (
          !tab ||
          (old.entityId === tab.entityId &&
            old.contentType === tab.contentType &&
            old.executionHostId === tab.executionHostId)
        )
      })
      const liveTerminals = new Map((state.tabsByWorktree[id] ?? []).map((tab) => [tab.id, tab]))
      const terminals = captured.terminals.filter((old) => {
        const tab = liveTerminals.get(old.id)
        return (
          !tab ||
          (old.generation === tab.generation &&
            (!tab.ptyId || old.ptyId === tab.ptyId) &&
            collectPtyIdsForTab(state, tab.id, tab.ptyId).every((pty) =>
              captured.ptys.get(tab.id)?.includes(pty)
            ))
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
      const browsers = captured.browsers.filter(
        (old) =>
          !(state.browserTabsByWorktree[id] ?? []).some(
            (tab) =>
              tab.id === old.id &&
              (tab.worktreeId !== old.worktreeId ||
                tab.createdAt !== old.createdAt ||
                tab.sessionProfileId !== old.sessionProfileId ||
                tab.sessionPartition !== old.sessionPartition)
          ) &&
          !captured.tabs.some(
            (tab) =>
              tab.contentType === 'browser' &&
              tab.entityId === old.id &&
              !tabs.some((current) => current.id === tab.id)
          )
      )
      const intersection = (a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> =>
        new Set([...a].filter((id) => b.has(id)))
      return {
        ...captured,
        tabs,
        terminals,
        files,
        browsers,
        removed: {
          terminalTabIds: intersection(
            captured.removed.terminalTabIds,
            new Set([
              ...terminals.map((tab) => tab.id),
              ...tabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
            ])
          ),
          fileIds: intersection(captured.removed.fileIds, new Set(files.map((file) => file.id))),
          browserTabIds: intersection(
            captured.removed.browserTabIds,
            new Set(browsers.map((tab) => tab.id))
          ),
          otherTabIds: intersection(
            captured.removed.otherTabIds,
            new Set(tabs.map((tab) => tab.id))
          ),
          conversationIds: new Set(
            tabs.filter((tab) => tab.contentType === 'agent-session').map((tab) => tab.entityId)
          ),
          mixedTabPtyIds: captured.removed.mixedTabPtyIds
        }
      }
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
  const source = scope.sources.find((entry) => entry.source.workspaceId === captured.worktreeId)
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
