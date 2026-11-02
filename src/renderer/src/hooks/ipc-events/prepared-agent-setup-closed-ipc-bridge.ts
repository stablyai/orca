import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { tuiAgentDisplayName } from '../../../../shared/tui-agent-display-names'
import type { PreparedAgentSetupClosedEvent } from '../../../../shared/prepared-agent-launch'

export function showPreparedAgentSetupClosedNotice({
  worktreeId,
  agent
}: PreparedAgentSetupClosedEvent): void {
  const name = tuiAgentDisplayName(agent) ?? agent
  // Why a toast: the Setup terminal that would have explained this is gone, and the agent tab never opened.
  toast.info(
    translate(
      'agentLaunch.setupClosed',
      "Setup was closed before it finished, so {{agent}} wasn't started. Start {{agent}} from a new tab.",
      { agent: name }
    ),
    // Why a stable id: a second window must not stack the same notice.
    { id: `prepared-agent-setup-closed:${worktreeId}` }
  )
}

/** Main owns when this fires (once per launch); the renderer only presents it. */
export function registerPreparedAgentSetupClosedIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.ui.onPreparedAgentSetupClosed
  if (subscribe) {
    unsubs.push(subscribe(showPreparedAgentSetupClosedNotice))
  }
}
