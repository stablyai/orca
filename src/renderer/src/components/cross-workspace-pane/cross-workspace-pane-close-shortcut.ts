import { useAppStore } from '@/store/index'
import { focusActiveWorkspaceSurface } from '../sidebar/worktree-list/navigation/focus-workspace-surface'

/** Close pressed inside the pane: return its tab and hand the keyboard back to the workspace. */
export function closeCrossWorkspacePaneFromKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target.closest('[data-cross-workspace-pane]') === null) {
    return false
  }
  useAppStore.getState().setCrossWorkspacePane(null)
  focusActiveWorkspaceSurface()
  return true
}
