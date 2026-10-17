import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../../shared/claude/project-claude-account-preference'
import type { PtyPaneStartup } from './pty-connection-types'
import {
  refusedClaudeLaunchStartupsFor,
  startRefusedPaneOnActiveClaudeAccount
} from './refused-claude-launch-recovery'

/** The refusal toast's "Start on active account": the refused pane again, or a new Claude tab. */
export function startPaneOnActiveClaudeAccount(input: {
  paneId: number
  paneHost: object
  worktreeId: string
  restartPane: (paneId: number, startup: PtyPaneStartup) => void
}): void {
  startRefusedPaneOnActiveClaudeAccount({
    paneId: input.paneId,
    refusedStartups: refusedClaudeLaunchStartupsFor(input.paneHost),
    restartPane: input.restartPane,
    // Why no tab close: the old tab may hold live split siblings.
    openNewTab: () =>
      launchAgentInNewTab({
        requestId: newAgentLaunchRequestId(),
        agent: 'claude',
        worktreeId: input.worktreeId,
        claudeAccountId: ACTIVE_CLAUDE_ACCOUNT,
        launchSource: 'unknown'
      })
  })
}
