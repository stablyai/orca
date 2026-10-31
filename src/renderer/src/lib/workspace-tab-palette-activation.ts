import { sourceTabPresentation } from '../../../shared/workspace-presentation'
import { workspacePresentationFor, workspaceSourceOccurrence } from '@/store/workspace-source-state'
import { workspaceAdmittedFiles } from '@/store/workspace-admitted-files'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { activateWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { activateAndRevealWorkspace } from './worktree-activation'
import {
  findAmbiguousWorktreeIds,
  getPaletteOwnershipWorktreeIds,
  hasOpenFileExecutionHostEvidence,
  isOpenFileOwnedByWorktree,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'
import type { WorkspaceTabPaletteSearchResult } from './workspace-tab-palette-search'

export type WorkspaceTabPaletteActivationFailure =
  | 'missing-worktree'
  | 'missing-group'
  | 'missing-tab'
  | 'missing-file'

export type WorkspaceTabPaletteActivationResult =
  | { status: 'activated' }
  | { status: 'blocked' }
  | { status: 'failed'; reason: WorkspaceTabPaletteActivationFailure }

// Why: callers outside Cmd+J hold only the identifiers, not a full search result.
export type WorkspaceTabPaletteActivationTarget = Pick<
  WorkspaceTabPaletteSearchResult,
  'contentType' | 'entityId' | 'groupId' | 'tabId' | 'worktreeId'
> & { executionHostId?: ExecutionHostId }

type WorkspaceTabPaletteActivationState = Pick<
  AppState,
  | 'activateTab'
  | 'focusGroup'
  | 'folderWorkspaces'
  | 'getKnownWorktreeById'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'setActiveFile'
  | 'setActiveTab'
  | 'setActiveTabType'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
  | 'workspacePresentations'
>

function validateTarget(
  state: WorkspaceTabPaletteActivationState,
  result: WorkspaceTabPaletteActivationTarget
): WorkspaceTabPaletteActivationFailure | null {
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(getPaletteOwnershipWorktreeIds(state))
  if (!result.executionHostId && ambiguousWorktreeIds.has(result.worktreeId)) {
    return 'missing-worktree'
  }
  const worktree = state.getKnownWorktreeById(result.worktreeId, result.executionHostId)
  if (!worktree) {
    return 'missing-worktree'
  }
  const group = (state.groupsByWorktree[result.worktreeId] ?? []).find(
    (candidate) => candidate.id === result.groupId
  )
  if (!group) {
    return 'missing-group'
  }
  const presented = workspacePresentationFor(state, result.worktreeId)
  const source = workspaceSourceOccurrence(state, result.tabId, result.worktreeId)
  const tabs = (state.unifiedTabsByWorktree[result.worktreeId] ?? []).filter(
    (candidate) => candidate.id === result.tabId
  )
  const tab = tabs.find(
    (candidate) =>
      candidate.entityId === result.entityId &&
      candidate.groupId === result.groupId &&
      candidate.contentType === result.contentType &&
      (presented
        ? source?.tab.entityId === candidate.entityId &&
          sourceTabPresentation(source.tab, source.source).entity.hostId ===
            (candidate.executionHostId ?? 'local')
        : isUnifiedTabOwnedByWorktree(candidate, worktree, ambiguousWorktreeIds))
  )
  if (tabs.length !== 1 || !tab) {
    return 'missing-tab'
  }
  if (result.contentType !== 'terminal') {
    const files = workspaceAdmittedFiles(state, result.worktreeId).filter(
      (file) => file.id === result.entityId
    )
    if (files.length !== 1) {
      return 'missing-file'
    }
    const file = files[0]
    // A hostless file falls back to local ownership, which only decides the match when IDs collide.
    const requiresOwnershipCheck =
      hasOpenFileExecutionHostEvidence(file) || ambiguousWorktreeIds.has(worktree.id)
    if (!presented && requiresOwnershipCheck && !isOpenFileOwnedByWorktree(file, worktree)) {
      return 'missing-file'
    }
  }
  return null
}

export function activateWorkspaceTabPaletteResult(
  result: WorkspaceTabPaletteActivationTarget
): WorkspaceTabPaletteActivationResult {
  const initialState = useAppStore.getState()
  const initialFailure = validateTarget(initialState, result)
  if (initialFailure) {
    return { status: 'failed', reason: initialFailure }
  }

  const executionHostId =
    result.executionHostId ?? initialState.getKnownWorktreeById(result.worktreeId)?.hostId
  const activated = executionHostId
    ? activateAndRevealWorkspace(result.worktreeId, { executionHostId })
    : activateAndRevealWorkspace(result.worktreeId)
  if (!activated) {
    return { status: 'blocked' }
  }

  const state = useAppStore.getState()
  const finalFailure = validateTarget(state, result)
  if (finalFailure) {
    return { status: 'failed', reason: finalFailure }
  }

  const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, result.worktreeId)
  state.focusGroup(result.worktreeId, result.groupId)
  state.activateTab(result.tabId, { worktreeId: result.worktreeId })

  if (result.contentType === 'terminal') {
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void activateWebRuntimeSessionTab({
        worktreeId: result.worktreeId,
        tabId: result.entityId,
        environmentId: runtimeEnvironmentId
      })
    }
    state.setActiveTab(result.entityId)
    state.setActiveTabType('terminal', result.worktreeId)
    focusTerminalTabSurface(result.entityId)
    return { status: 'activated' }
  }

  state.setActiveFile(result.entityId, result.worktreeId)
  // setActiveFile may pick an editor tab for the same entity instead of this diff.
  state.activateTab(result.tabId, { worktreeId: result.worktreeId })
  state.setActiveTabType('editor', result.worktreeId)
  return { status: 'activated' }
}
