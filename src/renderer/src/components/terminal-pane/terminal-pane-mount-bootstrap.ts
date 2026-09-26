import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import type {
  TerminalPaneSetupSplit,
  TerminalPaneIssueCommandSplit
} from './terminal-pane-lifecycle-types'
import { splitPaneWithOneShotStartup } from './terminal-pane-lifecycle-primitives'

export function runTerminalPaneBootstrapSplits(args: {
  manager: PaneManager
  ptyDeps: PtyConnectionDeps
  setupSplit: TerminalPaneSetupSplit | null | undefined
  issueCommandSplit: TerminalPaneIssueCommandSplit | null | undefined
  isActive: boolean
}): void {
  const { manager, ptyDeps, setupSplit, issueCommandSplit, isActive } = args
  const initialPane = manager.getActivePane() ?? manager.getPanes()[0]
  let issueAutomationAnchorPaneId: number | null = null
  if (setupSplit && initialPane) {
    const setupPane = splitPaneWithOneShotStartup(
      ptyDeps,
      { command: setupSplit.command, env: setupSplit.env },
      () => manager.splitPane(initialPane.id, setupSplit.direction)
    )
    issueAutomationAnchorPaneId = setupPane?.id ?? null
    manager.setActivePane(initialPane.id, { focus: isActive })
  }
  if (!issueCommandSplit) {
    return
  }
  let targetPane = manager.getActivePane() ?? manager.getPanes()[0] ?? null
  if (issueAutomationAnchorPaneId !== null) {
    targetPane =
      manager.getPanes().find((pane) => pane.id === issueAutomationAnchorPaneId) ?? targetPane
  }
  if (!targetPane) {
    return
  }
  splitPaneWithOneShotStartup(
    ptyDeps,
    { command: issueCommandSplit.command, env: issueCommandSplit.env },
    () => manager.splitPane(targetPane.id, 'vertical')
  )
  const focusPaneId =
    issueAutomationAnchorPaneId !== null ? (initialPane?.id ?? targetPane.id) : targetPane.id
  manager.setActivePane(focusPaneId, { focus: isActive })
}
