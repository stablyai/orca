import { useAppStore } from '@/store'
import { activateWebRuntimeSessionWorktreeOnEnvironment } from '@/runtime/web-runtime-worktree-activation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { findFirstIndexedWorktree } from './workspace/ownership/worktree-runtime-owner-index'
import { selectWorkspaceByHostTarget } from '@/store/workspaces/selection/workspace-host-target'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { revealFloatingWorkspacePanel } from './floating-workspace-panel-reveal'
import { findPendingWorktreeCreationId } from './workspace/creation/pending-worktree-creation'
import { openableFolderWorkspace } from './workspace/activation/worktree-activation'
import { wakeWorkspaceAgents } from './worktree-activation-agent-wake'
import { liftSidebarFiltersHidingWorktree } from './workspace/activation/worktree-activation-sidebar-filters'
import { buildActivationStateTransition } from './workspace/activation/worktree-activation-visit'
import {
  getKnownExecutionHostIdForWorktree,
  getUnstampedExecutionHostId,
  runtimeEnvironmentIdOrLocalUnlessTwin
} from './workspace/ownership/worktree-runtime-owner'
import { activateWslMovedWorkspace } from './wsl-moved-chat-activation'

/** Show an addressed chat's workspace on its host without starting anything there. False when
 *  that host's current registration is unproven, so the opener asks the host to place the chat. */
export function showStructuredChatWorkspace(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  feedback: { reported: boolean }
): boolean {
  if (isFloatingWorkspaceId(worktreeId)) {
    revealFloatingWorkspacePanel(useAppStore.getState())
    return true
  }
  if (activateWslMovedWorkspace(worktreeId)) {
    return true
  }
  const folder = parseWorkspaceKey(worktreeId)
  const state = useAppStore.getState()
  let repoId: string | null = null
  if (folder?.type === 'folder') {
    // The blocked path's toast is this interaction's one failure message.
    const openable = openableFolderWorkspace(
      folder.folderWorkspaceId,
      executionHostId,
      undefined,
      feedback.reported
    )
    feedback.reported ||= openable === 'blocked'
    if (!openable || openable === 'blocked') {
      return false
    }
  } else {
    // Listed rows only: a detected checkout is not a current registration.
    const worktree = executionHostId
      ? selectWorkspaceByHostTarget(
          state,
          hostWorktreeTarget({ id: worktreeId, hostId: executionHostId })
        )
      : findFirstIndexedWorktree(selectWorktreesByRepo(state), worktreeId)
    if (!worktree || findPendingWorktreeCreationId(state.pendingWorktreeCreations, worktree.id)) {
      return false
    }
    liftSidebarFiltersHidingWorktree(worktree)
    repoId = worktree.repoId
  }
  const switched =
    state.activeWorktreeId !== worktreeId ||
    (executionHostId !== undefined &&
      (state.activeWorkspaceExecutionHostId ??
        getKnownExecutionHostIdForWorktree(state, worktreeId) ??
        getUnstampedExecutionHostId(state)) !== executionHostId)
  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }
  state.setActiveWorktree(worktreeId, executionHostId, {
    ...buildActivationStateTransition(state, worktreeId, {
      repoId: repoId ?? state.activeRepoId ?? '',
      stampsVisit: switched,
      nextHostId: executionHostId ?? null
    }),
    selectOnly: true
  })
  state.revealWorktreeInSidebar(worktreeId, executionHostId ? { executionHostId } : undefined)
  if (switched) {
    wakeSwitchedWorkspace(worktreeId, executionHostId, repoId !== null)
  }
  return true
}

/** Opening a workspace from another one wakes what sleeps there, as any workspace switch does;
 *  the workspace already on screen is never woken by a chat open. */
function wakeSwitchedWorkspace(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  isWorktree: boolean
): void {
  const state = useAppStore.getState()
  state.setActiveWorktree(worktreeId, executionHostId)
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  if (isWorktree && environmentId && isWebRuntimeSessionActive(environmentId)) {
    void activateWebRuntimeSessionWorktreeOnEnvironment({ worktreeId, environmentId })
  }
  wakeWorkspaceAgents(worktreeId, {
    hasActivationWork: false,
    callerProvidesSurface: true,
    seedUserDefaultSurface: false,
    ...(executionHostId ? { executionHostId } : {})
  })
}
