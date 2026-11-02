import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { tuiAgentDisplayName } from '../../../../shared/tui-agent-display-names'
import type { PreparedAgentLaunchNotice } from '../../../../shared/prepared-agent-launch'

function noticeText({ kind, agent }: PreparedAgentLaunchNotice): string {
  const name = tuiAgentDisplayName(agent) ?? agent
  return kind === 'setup-closed'
    ? translate(
        'agentLaunch.setupClosed',
        "Setup was closed before it finished, so {{agent}} wasn't started. Start {{agent}} from a new tab.",
        { agent: name }
      )
    : translate(
        'agentLaunch.promptUncertain',
        '{{agent}} started, but its first prompt may not have been delivered. Check {{agent}} before sending the prompt again.',
        { agent: name }
      )
}

export function showPreparedAgentLaunchNotice(notice: PreparedAgentLaunchNotice): void {
  // Why a toast: no surviving terminal shows this outcome (closed Setup, or a prompt in doubt).
  // Why the operation id: every observer of one launch replaces the same notice instead of stacking.
  toast.info(noticeText(notice), { id: `prepared-agent-launch:${notice.operationId}` })
}

/** Main owns when this fires; the renderer only presents it. */
export function registerPreparedAgentLaunchNoticeIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.ui.onPreparedAgentLaunchNotice
  if (subscribe) {
    unsubs.push(subscribe(showPreparedAgentLaunchNotice))
  }
}
