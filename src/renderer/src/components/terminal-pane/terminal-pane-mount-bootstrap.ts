import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { TerminalPaneIssueCommandSplit } from './terminal-pane-lifecycle-types'
import { splitPaneWithOneShotStartup } from './terminal-pane-lifecycle-primitives'

export type BootstrapSplitManager = Pick<
  PaneManager,
  'getActivePane' | 'getPanes' | 'setActivePane' | 'splitPane'
>

export function runTerminalPaneBootstrapSplits(args: {
  manager: BootstrapSplitManager
  ptyDeps: PtyConnectionDeps
  issueCommandSplit: TerminalPaneIssueCommandSplit | null | undefined
  isActive: boolean
}): void {
  const { manager, ptyDeps, issueCommandSplit, isActive } = args
  const targetPane = manager.getActivePane() ?? manager.getPanes()[0]
  if (!issueCommandSplit || !targetPane) {
    return
  }
  splitPaneWithOneShotStartup(
    ptyDeps,
    { command: issueCommandSplit.command, env: issueCommandSplit.env },
    () => manager.splitPane(targetPane.id, 'vertical')
  )
  manager.setActivePane(targetPane.id, { focus: isActive })
}
