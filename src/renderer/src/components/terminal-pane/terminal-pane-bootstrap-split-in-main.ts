import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneIssueCommandSplit } from './terminal-pane-lifecycle-types'
import { splitPaneFirstSize, splitPaneInMain } from './terminal-pane-split-in-main'
import { runTerminalPaneBootstrapSplits } from './terminal-pane-mount-bootstrap'
import type { PtyConnectionDeps } from './pty-connection-types'

/**
 * A tab's startup split in a layout-owner build: main writes it and starts its command; main's
 * frame draws the pane. A paired server's tab splits in the window as today.
 */
export function runBootstrapSplitInMain(args: {
  manager: PaneManager
  worktreeId: string
  tabId: string
  ptyDeps: PtyConnectionDeps
  issueCommandSplit: TerminalPaneIssueCommandSplit | null | undefined
  isActive: boolean
}): void {
  const { manager, issueCommandSplit } = args
  const targetPane = manager.getActivePane() ?? manager.getPanes()[0]
  const asToday = (): void =>
    runTerminalPaneBootstrapSplits({
      manager: args.manager,
      ptyDeps: args.ptyDeps,
      issueCommandSplit,
      isActive: args.isActive
    })
  if (!issueCommandSplit || !targetPane) {
    return
  }
  const sentToMain = splitPaneInMain(
    {
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      sourceLeafId: targetPane.leafId,
      direction: 'vertical',
      initialSize: splitPaneFirstSize(targetPane.terminal, 'vertical'),
      keepSourceFocused: true,
      command: issueCommandSplit.command,
      ...(issueCommandSplit.env ? { env: issueCommandSplit.env } : {})
    },
    asToday
  )
  if (!sentToMain) {
    asToday()
  }
}
