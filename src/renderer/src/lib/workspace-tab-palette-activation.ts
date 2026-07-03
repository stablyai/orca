import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { activateAndRevealWorktree } from './worktree-activation'
import type { WorkspaceTabPaletteSearchResult } from './workspace-tab-palette-search'

export type WorkspaceTabPaletteActivationFailure =
  | 'missing-worktree'
  | 'missing-group'
  | 'missing-tab'
  | 'missing-file'

export type WorkspaceTabPaletteActivationResult =
  | { status: 'activated' }
  | { status: 'failed'; reason: WorkspaceTabPaletteActivationFailure }

type WorkspaceTabPaletteActivationState = Pick<
  AppState,
  | 'activateTab'
  | 'activeGroupIdByWorktree'
  | 'focusGroup'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'repos'
  | 'settings'
  | 'setActiveFile'
  | 'setActiveTab'
  | 'setActiveTabType'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
>

function validateTarget(
  state: WorkspaceTabPaletteActivationState,
  result: WorkspaceTabPaletteSearchResult
): WorkspaceTabPaletteActivationFailure | null {
  if (!findWorktreeById(state.worktreesByRepo, result.worktreeId)) {
    return 'missing-worktree'
  }
  const group = (state.groupsByWorktree[result.worktreeId] ?? []).find(
    (candidate) => candidate.id === result.groupId
  )
  if (!group) {
    return 'missing-group'
  }
  const tab = (state.unifiedTabsByWorktree[result.worktreeId] ?? []).find(
    (candidate) =>
      candidate.id === result.tabId &&
      candidate.entityId === result.entityId &&
      candidate.groupId === result.groupId &&
      candidate.worktreeId === result.worktreeId &&
      candidate.contentType === result.contentType
  )
  if (!tab) {
    return 'missing-tab'
  }
  if (
    result.contentType !== 'terminal' &&
    !state.openFiles.some(
      (file) => file.id === result.entityId && file.worktreeId === result.worktreeId
    )
  ) {
    return 'missing-file'
  }
  return null
}

export function activateWorkspaceTabPaletteResult(
  result: WorkspaceTabPaletteSearchResult
): WorkspaceTabPaletteActivationResult {
  const initialState = useAppStore.getState()
  const initialFailure = validateTarget(initialState, result)
  if (initialFailure) {
    return { status: 'failed', reason: initialFailure }
  }

  const activated = activateAndRevealWorktree(result.worktreeId)
  if (!activated) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  const state = useAppStore.getState()
  const finalFailure = validateTarget(state, result)
  if (finalFailure) {
    return { status: 'failed', reason: finalFailure }
  }

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, result.worktreeId)
  state.focusGroup(result.worktreeId, result.groupId)
  state.activateTab(result.tabId)

  if (result.contentType === 'terminal') {
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void activateWebRuntimeSessionTab({
        worktreeId: result.worktreeId,
        tabId: result.entityId,
        environmentId: runtimeEnvironmentId
      })
    }
    state.setActiveTab(result.entityId)
    state.setActiveTabType('terminal')
    focusTerminalTabSurface(result.entityId)
    return { status: 'activated' }
  }

  state.setActiveFile(result.entityId)
  state.setActiveTabType('editor')
  return { status: 'activated' }
}
