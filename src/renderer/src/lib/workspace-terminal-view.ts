import { useAppStore } from '@/store'

/**
 * The user is looking at this workspace: the terminal route, no pending create in front, and it is
 * the active workspace. Work that finishes in a workspace the user left announces itself instead
 * of pulling them back to it (#9944).
 */
export function isWorkspaceInTerminalView(worktreeId: string): boolean {
  const state = useAppStore.getState()
  return (
    state.activeView === 'terminal' &&
    state.activePendingCreationId === null &&
    state.activeWorktreeId === worktreeId
  )
}
