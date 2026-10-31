import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace-switch-user-act'
import { useAppStore } from '../../store'

/**
 * True once for a chat mount the user's own switch to its workspace caused, so only that open may
 * start a stopped WSL distro (E9). A launch restore, reload or remount is false.
 */
export function takeNativeChatOpenWake(chatSourceKey: string): boolean {
  const worktreeId = useAppStore.getState().activeWorktreeId
  return (
    worktreeId !== null && takeRecentWorkspaceSwitchWake(worktreeId, `native-chat:${chatSourceKey}`)
  )
}
