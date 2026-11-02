import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { tuiAgentDisplayName } from '../../../../shared/tui-agent-display-names'
import type { PreparedAgentLaunchNotice } from '../../../../shared/prepared-agent-launch'

function noticeText({ kind, agent }: PreparedAgentLaunchNotice): string {
  const name = tuiAgentDisplayName(agent) ?? agent
  const options = { agent: name }
  // Exhaustive: every final outcome main can project has its own sentence.
  switch (kind) {
    case 'setup-not-started':
      return translate(
        'agentLaunch.setupNotStarted',
        'Setup could not start, so {{agent}} was not started. Check the Setup command, then start {{agent}} from a new tab.',
        options
      )
    case 'setup-failed':
      return translate(
        'agentLaunch.setupFailed',
        'Setup failed, so {{agent}} was not started. Fix Setup, then start {{agent}} from a new tab.',
        options
      )
    case 'setup-timeout':
      return translate(
        'agentLaunch.setupTimeout',
        'Setup did not finish within 2 hours, so {{agent}} was not started. Start {{agent}} from a new tab when Setup is done.',
        options
      )
    case 'setup-ended':
      return translate(
        'agentLaunch.setupClosed',
        "Setup was closed before it finished, so {{agent}} wasn't started. Start {{agent}} from a new tab.",
        options
      )
    case 'exited':
      return translate(
        'agentLaunch.exited',
        '{{agent}} exited right after it started. Start {{agent}} again from a new tab.',
        options
      )
    case 'spawn-failed':
      return translate(
        'agentLaunch.spawnFailed',
        '{{agent}} could not be started. Check the agent command in Settings, then start {{agent}} from a new tab.',
        options
      )
    case 'expired':
      return translate(
        'agentLaunch.notStarted',
        '{{agent}} could not be started. Start {{agent}} from a new tab.',
        options
      )
    case 'prompt-uncertain':
      return translate(
        'agentLaunch.promptUncertain',
        '{{agent}} started, but its first prompt may not have been delivered. Check {{agent}} before sending the prompt again.',
        options
      )
  }
}

export function showPreparedAgentLaunchNotice(notice: PreparedAgentLaunchNotice): void {
  // Why a toast: no surviving terminal shows this outcome, or its Setup could not take the line.
  // Main sends it once, from the transaction that retired the launch; the id only labels it.
  toast.info(noticeText(notice), { id: `prepared-agent-launch:${notice.operationId}` })
}

/** Main owns when this fires; the renderer only presents it. */
export function registerPreparedAgentLaunchNoticeIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.ui.onPreparedAgentLaunchNotice
  if (subscribe) {
    unsubs.push(subscribe(showPreparedAgentLaunchNotice))
  }
}
