import type { AppState } from '@/store/types'
import { isEditableTarget } from '@/lib/editable-target'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import { getActiveSidebarWorkspaceId } from '../../../../shared/workspace-scope'
import type { DetectedWorktree, Worktree } from '../../../../shared/worktree/types'
import {
  getHoveredWorkspaceIdentity,
  type HoveredWorkspaceDocument
} from './hovered-sidebar-workspace-identity'

export type WorkspacePinIntent = 'pin' | 'unpin' | 'toggle'

export type WorkspacePinShortcutState = Pick<
  AppState,
  | 'activeModal'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'getKnownWorktreeById'
  | 'setWorktreesPinnedAndReveal'
>

/** Hovered sidebar row wins, so the chord pins what the pointer points at; otherwise the focused workspace. */
export function resolveWorkspacePinShortcutTarget(
  state: WorkspacePinShortcutState,
  doc: HoveredWorkspaceDocument = document
): Worktree | DetectedWorktree | null {
  if (state.activeModal !== 'none' || (doc.activeElement && isEditableTarget(doc.activeElement))) {
    return null
  }
  const hovered = getHoveredWorkspaceIdentity(doc)
  if (hovered) {
    const executionHostId = getExecutionHostIdFromWorktreeHostIdentity(hovered.hostIdentity)
    const candidate = executionHostId
      ? state.getKnownWorktreeById(hovered.workspaceId, executionHostId)
      : state.getKnownWorktreeById(hovered.workspaceId)
    // An unqualified row names no host, so an id-only match may be a twin on
    // another one; refuse rather than pin the wrong card, as the delete path does.
    return candidate && getWorktreeHostIdentity(candidate) === hovered.hostIdentity
      ? candidate
      : null
  }
  const activeWorkspaceId = getActiveSidebarWorkspaceId(
    state.activeWorkspaceKey,
    state.activeWorktreeId
  )
  if (!activeWorkspaceId) {
    return null
  }
  return (
    (state.activeWorkspaceExecutionHostId
      ? state.getKnownWorktreeById(activeWorkspaceId, state.activeWorkspaceExecutionHostId)
      : state.getKnownWorktreeById(activeWorkspaceId)) ?? null
  )
}

export function applyWorkspacePinIntent(
  state: WorkspacePinShortcutState,
  target: Worktree | DetectedWorktree,
  intent: WorkspacePinIntent
): void {
  state.setWorktreesPinnedAndReveal(
    [target.hostId ? { worktreeId: target.id, executionHostId: target.hostId } : target.id],
    intent === 'toggle' ? !target.isPinned : intent === 'pin'
  )
}
