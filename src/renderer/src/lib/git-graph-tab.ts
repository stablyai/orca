import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { captureWorktreeOperationGenerationSnapshot } from './workspace/ownership/worktree-operation-generation'
import { useAppStore } from '@/store'
import {
  findFirstIndexedWorktree,
  findIndexedWorktreeOwnerForHost
} from './workspace/ownership/worktree-runtime-owner-index'
import { findIndexedRepoOwnerForHost } from './workspace/ownership/repo-owner-index'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import {
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteForHost,
  type WorktreeOperationRouteState
} from './workspace/ownership/worktree-operation-route'
import { openWorkspaceEditorItem } from '@/store/slices/editor/tabs/workspace-editor-item'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { GIT_GRAPH_TAB_CAPABILITY } from '../../../shared/source-control/runtime/git-graph-capabilities'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import {
  getSshTargetIdForExecutionHost,
  type ExecutionHostId
} from '../../../shared/execution-host'

export const GIT_GRAPH_REFRESH_EVENT = 'orca:git-graph-refresh'

type ScopeState = WorktreeOperationRouteState &
  Pick<ReturnType<typeof useAppStore.getState>, 'repos' | 'worktreesByRepo'>

export function gitGraphScopeInputs(state: ReturnType<typeof useAppStore.getState>) {
  return {
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    folderWorkspaces: selectFolderWorkspaces(state),
    projectGroups: state.projectGroups,
    settings: state.settings,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId
  }
}

export function useGitGraphScope(worktreeId: string, executionHostId?: ExecutionHostId) {
  const inputs = useAppStore(useShallow(gitGraphScopeInputs))
  return useMemo(
    () => gitGraphScope(worktreeId, inputs, executionHostId),
    [worktreeId, inputs, executionHostId]
  )
}

export function gitGraphScope(
  worktreeId: string,
  state: ScopeState = useAppStore.getState(),
  executionHostId?: ExecutionHostId
) {
  const worktrees = selectWorktreesByRepo(state)
  const route = executionHostId
    ? resolveWorktreeOperationRouteForHost(state, worktreeId, executionHostId)
    : resolveWorktreeOperationRoute(state, worktreeId)
  const worktree = route?.executionHostId
    ? findIndexedWorktreeOwnerForHost(worktrees, worktreeId, route.executionHostId)
    : findFirstIndexedWorktree(worktrees, worktreeId)
  const repo =
    worktree &&
    route?.executionHostId &&
    findIndexedRepoOwnerForHost(state.repos, worktree.repoId, route.executionHostId)
  return worktree && route && repo?.kind !== 'folder'
    ? {
        worktree,
        route,
        connectionId: getSshTargetIdForExecutionHost(route.executionHostId),
        target: runtimeTargetForOwnerEnvironment(route.runtimeEnvironmentId)
      }
    : null
}

export function gitGraphSupport(worktreeId: string): boolean | null {
  const scope = gitGraphScope(worktreeId)
  if (!scope) {
    return null
  }
  return scope.target.kind === 'local'
    ? true
    : readCachedRuntimeEnvironmentCapability(scope.target.environmentId, GIT_GRAPH_TAB_CAPABILITY)
}

export async function probeGitGraphSupport(worktreeId: string): Promise<boolean | null> {
  const scope = gitGraphScope(worktreeId)
  if (!scope) {
    return null
  }
  return scope.target.kind === 'local'
    ? true
    : runtimeEnvironmentSupportsCapability(scope.target.environmentId, GIT_GRAPH_TAB_CAPABILITY)
}

export function gitGraphUpdateMessage(worktreeId: string, t: Translate = translate): string {
  const scope = gitGraphScope(worktreeId)
  const state = useAppStore.getState()
  const environmentId =
    scope?.target.kind === 'environment' ? scope.target.environmentId : undefined
  const environment =
    scope?.target.kind === 'environment'
      ? state.runtimeEnvironments?.find((entry) => entry.id === environmentId)
      : undefined
  return t('gitGraph.updateHost', 'Update Orca on {{host}} to open the Git Graph', {
    host: environment?.name ?? scope?.route.executionHostId ?? ''
  })
}

export async function openGitGraph(
  worktreeId: string,
  // Lazy so a split is created only when a new tab actually opens.
  resolveTargetGroupId?: () => string | undefined
): Promise<void> {
  const supported = await probeGitGraphSupport(worktreeId)
  if (!supported) {
    return
  }
  const scope = gitGraphScope(worktreeId)
  if (!scope) {
    return
  }
  const state = useAppStore.getState()
  const existing = state.unifiedTabsByWorktree?.[worktreeId]?.find(
    (tab) => tab.contentType === 'git-graph'
  )
  const id = existing?.entityId ?? `${worktreeId}::git-graph`
  const label = translate('gitGraph.title', 'Git Graph')
  if (state.openFiles.some((file) => file.id === id)) {
    openWorkspaceEditorItem(state, id, worktreeId, label, 'git-graph')
    return
  }
  state.openFile(
    {
      filePath: id,
      relativePath: label,
      worktreeId,
      runtimeEnvironmentId: scope.route.runtimeEnvironmentId,
      language: 'plaintext',
      operationProvenance: {
        generation: captureWorktreeOperationGenerationSnapshot(scope.route),
        ownershipProjection: 'explicit'
      },
      mode: 'git-graph'
    },
    { reopenId: id, preview: false, targetGroupId: resolveTargetGroupId?.() }
  )
}
