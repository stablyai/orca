import { collectPtyIdsForTab } from '../../terminal-tab-retirement'
import { webSessionOpenFilesForWorktree } from '@/runtime/web-session-tabs-sync/state-equality-files'
import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  strictWorktreeIdentityKey,
  type WorkspaceSourceRef
} from '../../../../../../shared/workspace-presentation'
import { rawWorkspaceState, workspacePresentationFor } from '../../../workspace-source-state'
import { selectWorkspaceByHostTarget } from '../../../workspace-record-selectors'
import {
  collectRemovedHostTwinState,
  type RemovedHostTwinState
} from '../../../repos/repo-removal-host-twin-attribution'
import { workspacePublishingHosts } from './host-twin-worktree-purge'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'
import { captureWorktreeOperationGenerationSnapshot } from '@/lib/worktree-operation-generation'
import type { WorktreeOperationRoute } from '@/lib/worktree-operation-route'

export type WorkspaceRemovalSource = {
  source: WorkspaceSourceRef
  removed: RemovedHostTwinState
  tabs: AppState['unifiedTabsByWorktree'][string]
  terminals: AppState['tabsByWorktree'][string]
  files: AppState['openFiles']
  browsers: AppState['browserTabsByWorktree'][string]
  row: ReturnType<typeof selectWorkspaceByHostTarget>
  ptys: ReadonlyMap<string, readonly string[]>
}
export type WorkspaceRemovalScope = {
  target: { id: string; hostId: ExecutionHostId }
  row: ReturnType<typeof selectWorkspaceByHostTarget>
  generation?: ReturnType<typeof captureWorktreeOperationGenerationSnapshot>
  sources: WorkspaceRemovalSource[]
}

/** Association locates resources; positive raw host attribution supplies the destructive scope. */
export function captureWorkspaceRemovalScope(
  view: AppState,
  target: WorkspaceRemovalScope['target'],
  route?: WorktreeOperationRoute | null
): WorkspaceRemovalScope {
  const state = rawWorkspaceState(view)
  const row = selectWorkspaceByHostTarget(state, target)
  const saved = workspacePresentationFor(view, target.id)
  const refs: WorkspaceSourceRef[] = [
    { hostId: target.hostId, executionHostId: row?.hostId, workspaceId: target.id }
  ]
  if (
    saved &&
    (saved.anchor.hostId === target.hostId || saved.anchor.executionHostId === target.hostId)
  ) {
    refs.push(
      ...saved.baseline
        .map(({ source }) => source)
        .filter(
          (source) =>
            strictWorktreeIdentityKey(source.workspaceId) ===
              strictWorktreeIdentityKey(target.id) &&
            (source.hostId === target.hostId || source.executionHostId === target.hostId) &&
            (!row || isExecutionHostAliasForWorktree(source.executionHostId ?? source.hostId, row))
        )
    )
  }
  const sources = new Map<string, WorkspaceRemovalSource>()
  for (const source of refs) {
    const id = source.workspaceId
    const host = source.executionHostId ?? source.hostId
    const survivors = workspacePublishingHosts(state, id).filter(
      (owner) => owner !== host && owner !== source.hostId
    )
    const removed = collectRemovedHostTwinState(
      state,
      new Set([id]),
      host,
      new Map([[id, survivors]])
    )
    if (row && host === 'local' && !survivors.length) {
      for (const tab of state.tabsByWorktree[id] ?? []) {
        const stamp = (state.unifiedTabsByWorktree[id] ?? []).find(
          (entry) => entry.entityId === tab.id
        )?.executionHostId
        if (!stamp && !tab.ptyId && !state.ptyIdsByTabId[tab.id]?.length) {
          removed.terminalTabIds.add(tab.id)
        }
      }
      for (const tab of state.unifiedTabsByWorktree[id] ?? []) {
        if (!tab.executionHostId && !['editor', 'terminal', 'browser'].includes(tab.contentType)) {
          removed.otherTabIds.add(tab.id)
          if (tab.contentType === 'agent-session') {
            removed.conversationIds.add(tab.entityId)
          }
        }
      }
    }
    sources.set(id, {
      source,
      row: selectWorkspaceByHostTarget(state, { id, hostId: source.hostId }),
      ptys: new Map(
        (state.tabsByWorktree[id] ?? []).map((tab) => [
          tab.id,
          collectPtyIdsForTab(state, tab.id, tab.ptyId)
        ])
      ),
      removed,
      tabs: (state.unifiedTabsByWorktree[id] ?? []).filter(
        (tab) =>
          removed.otherTabIds.has(tab.id) ||
          removed.terminalTabIds.has(tab.entityId) ||
          removed.browserTabIds.has(tab.entityId) ||
          removed.fileIds.has(tab.entityId)
      ),
      terminals: (state.tabsByWorktree[id] ?? []).filter((tab) =>
        removed.terminalTabIds.has(tab.id)
      ),
      files: webSessionOpenFilesForWorktree(state, id).filter((file) =>
        removed.fileIds.has(file.id)
      ),
      browsers: (state.browserTabsByWorktree[id] ?? []).filter((tab) =>
        removed.browserTabIds.has(tab.id)
      )
    })
  }
  return {
    target,
    row,
    sources: [...sources.values()],
    generation: route ? captureWorktreeOperationGenerationSnapshot(route) : undefined
  }
}

export {
  workspaceRemovalScopeIsCurrent,
  assertWorkspaceRemovalScopeCurrent,
  currentWorkspaceRemovalSources,
  workspaceRemovalTabIsCurrent
} from './workspace-removal-currentness'
