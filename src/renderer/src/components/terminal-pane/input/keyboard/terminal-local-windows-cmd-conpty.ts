import { useAppStore } from '@/store/index'
import { resolveWindowsShellStartupFamily } from '../../../../../../shared/windows-terminal-shell'

/** ConPTY cooked cmd deletes a word on BS. Other shells keep Ctrl+W. */
export function isCmdExeConptyShell(
  localWindowsConpty: boolean,
  shell: string | null | undefined
): boolean {
  return localWindowsConpty && resolveWindowsShellStartupFamily(shell) === 'cmd'
}

export function readLocalWindowsCmdConptyPane(args: {
  isLocalWindowsConptyPane: () => boolean
  getPaneId: () => number | undefined
  getSessionShell: (paneId: number) => string | undefined
  worktreeId: string
  tabId: string
}): boolean {
  if (!args.isLocalWindowsConptyPane()) {
    return false
  }
  const paneId = args.getPaneId()
  const sessionShell = paneId === undefined ? undefined : args.getSessionShell(paneId)
  const tabShell = useAppStore
    .getState()
    .tabsByWorktree[args.worktreeId]?.find(
      (candidate) => candidate.id === args.tabId
    )?.shellOverride
  // Why: session metadata wins, matching the ConPTY shell used for the live pty.
  return isCmdExeConptyShell(true, sessionShell ?? tabShell)
}
