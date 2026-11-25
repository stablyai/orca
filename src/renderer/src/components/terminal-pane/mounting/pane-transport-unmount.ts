import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'

export function shouldDetachPaneTransportOnUnmount(args: {
  tabStillExists: boolean
  tabId: string
  ptyId: string | null
  worktreeTabs: readonly TerminalTab[] | undefined
}): boolean {
  return Boolean(args.ptyId)
}
