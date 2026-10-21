import { translate } from '@/i18n/i18n'
import type { AgentLaunchPaneOutcome } from '../../../../shared/agent-launch-pane-verdict'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** What the pane shows, if its tab keeps a final launch outcome for this leaf. */
export function agentLaunchPaneOutcomeForLeaf(
  tab: Pick<TerminalTab, 'agentLaunchPane'> | null | undefined,
  leafId: string | null | undefined
): AgentLaunchPaneOutcome | null {
  const launchPane = tab?.agentLaunchPane
  return launchPane?.outcome && launchPane.leafId === leafId ? launchPane.outcome : null
}

/** The recorded reason in words a user can act on; null when it names nothing they can fix. */
function notStartedReason(code: string): string | null {
  if (code.includes('ENOENT')) {
    return translate(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.commandNotFound',
      "Its command wasn't found on this machine."
    )
  }
  if (code === 'agent_session_exited_during_start') {
    return translate(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.exitedDuringStart',
      'It exited while starting.'
    )
  }
  if (code === 'worktree_not_found') {
    return translate(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.workspaceGone',
      'Its workspace is no longer available.'
    )
  }
  return null
}

export function agentLaunchPaneNoticeText(refusal: AgentLaunchPaneOutcome): string {
  if (refusal.kind === 'unconfirmed') {
    return translate(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.unconfirmed',
      "Couldn't confirm the agent started."
    )
  }
  const lead = translate(
    'auto.components.terminal.pane.AgentLaunchPaneNotice.notStarted',
    "The agent couldn't start."
  )
  const reason = notStartedReason(refusal.code)
  return reason ? `${lead} ${reason}` : lead
}
