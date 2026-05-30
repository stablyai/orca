import { tabHasLivePty } from '@/lib/tab-has-live-pty'

export function hasSleepableWorkspaceActivity(
  worktreeId: string,
  tabsByWorktree: Record<string, { id: string }[]>,
  ptyIdsByTabId: Record<string, string[]>,
  browserTabsByWorktree: Record<string, { id: string }[]>
): boolean {
  const tabs = tabsByWorktree[worktreeId] ?? []
  const hasLiveTerminal = tabs.some((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))
  const hasBrowser = (browserTabsByWorktree[worktreeId] ?? []).length > 0
  return hasLiveTerminal || hasBrowser
}
