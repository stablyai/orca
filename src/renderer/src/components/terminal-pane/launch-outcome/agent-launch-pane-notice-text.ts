import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AgentLaunchPaneOutcome } from '../../../../../shared/agent-launch/contracts/agent-launch-pane-verdict'
import { stripClientEnvironmentFooter } from '../../../../../shared/client-environment-info'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { tuiAgentDisplayName } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'

/** What the pane shows, if its tab keeps a final launch outcome for this leaf. */
export function agentLaunchPaneOutcomeForLeaf(
  tab: Pick<TerminalTab, 'agentLaunchPane'> | null | undefined,
  leafId: string | null | undefined
): AgentLaunchPaneOutcome | null {
  const launchPane = tab?.agentLaunchPane
  return launchPane?.outcome && launchPane.leafId === leafId ? launchPane.outcome : null
}

/** The recorded reason in words a user can act on; null when it names nothing they can fix. */
function notStartedReason(code: string, agent: string, t: Translate = translate): string | null {
  if (code.includes('ENOENT')) {
    return t(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.commandNotFound',
      "{{agent}} couldn't start because its command wasn't found on this machine.",
      { agent }
    )
  }
  if (code === 'agent_session_exited_during_start') {
    return t(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.exitedDuringStart',
      '{{agent}} exited while starting.',
      { agent }
    )
  }
  if (code === 'worktree_not_found') {
    return t(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.workspaceGone',
      "{{agent}} couldn't start because its workspace is no longer available.",
      { agent }
    )
  }
  return null
}

export function agentLaunchPaneNoticeText(
  refusal: AgentLaunchPaneOutcome,
  agentId?: string | null,
  t: Translate = translate
): string {
  const agent =
    tuiAgentDisplayName(agentId ?? '') ??
    t('auto.components.terminal.pane.AgentLaunchPaneNotice.agent', 'The agent')
  if (refusal.initialOutputDiagnostic === 'git-bash-console-capacity') {
    const explanation = t(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.gitBashConsoleCapacity',
      'Git Bash reported its limit of 128 open terminals on this PC while starting {{agent}}. Close some Git Bash terminals and try again.',
      { agent }
    )
    return refusal.kind === 'unconfirmed'
      ? `${t(
          'auto.components.terminal.pane.AgentLaunchPaneNotice.unconfirmed',
          "Couldn't confirm {{agent}} started. Check its terminal before trying again.",
          { agent }
        )} ${explanation}`
      : explanation
  }
  if (refusal.kind === 'unconfirmed') {
    return t(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.unconfirmed',
      "Couldn't confirm {{agent}} started. Check its terminal before trying again.",
      { agent }
    )
  }
  const reason =
    notStartedReason(refusal.code, agent, t) ??
    t(
      'auto.components.terminal.pane.AgentLaunchPaneNotice.notStarted',
      "{{agent}} couldn't start.",
      { agent }
    )
  const action =
    refusal.code === 'worktree_not_found'
      ? t(
          'auto.components.terminal.pane.AgentLaunchPaneNotice.restoreWorkspace',
          'Restore the workspace folder or open an available workspace, then try again.'
        )
      : t(
          'auto.components.terminal.pane.AgentLaunchPaneNotice.tryInTerminal',
          'Run it in a terminal in this folder to see why, then try again.'
        )
  return `${reason} ${action}`
}

function startupCode(line: string): string | undefined {
  return line.match(/\b(?:agent_(?:session|launch)_[a-z0-9_]+|worktree_not_found)\b/)?.[0]
}

export function isAgentLaunchOnlyError(error: string): boolean {
  const lines = stripClientEnvironmentFooter(error)
    .split('\n')
    .filter((line) => line.trim().length > 0)
  return lines.length > 0 && lines.every((line) => startupCode(line) !== undefined)
}

/** Older hosts send startup reasons as strings, sometimes wrapped in an IPC error. */
export function agentLaunchErrorText(
  error: string,
  agentId?: string | null,
  t?: Translate
): string | null {
  let found = false
  const text = error
    .split('\n')
    .map((line) => {
      const code = startupCode(line)
      if (!code) {
        return line
      }
      found = true
      // Only these producer contracts prove failure without an attempt's typed host outcome.
      const outcome: AgentLaunchPaneOutcome =
        code === 'agent_session_exited_during_start' || code === 'worktree_not_found'
          ? { kind: 'not-started', code }
          : { kind: 'unconfirmed' }
      return agentLaunchPaneNoticeText(outcome, agentId, t)
    })
    .join('\n')
  return found ? text : null
}
