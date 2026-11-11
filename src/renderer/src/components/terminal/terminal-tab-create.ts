import { createFreshTerminal } from '@/store/terminals/fresh-terminal-creation'

export function createNewTerminalTab(
  activeWorktreeId: string | null,
  shellOverride?: string,
  options?: {
    startupCwd?: string
    command?: string
    /** Reports whether the tab was created; a caller that passes it reports failure itself. */
    onSettled?: (started: boolean) => void
  }
): void {
  if (!activeWorktreeId) {
    options?.onSettled?.(false)
    return
  }
  void createFreshTerminal({
    worktreeId: activeWorktreeId,
    shell: shellOverride,
    cwd: options?.startupCwd,
    command: options?.command,
    ...(options?.onSettled ? { notifyFailure: false } : {})
  }).then(
    (created) => options?.onSettled?.(created),
    () => options?.onSettled?.(false)
  )
}
