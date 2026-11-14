import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../../shared/claude/project-claude-account-preference'
import type { PtyPaneStartup } from './pty-connection/startup/pty-pane-startup'
import { agentLaunchPanePrompt } from '@/lib/agent-session/launch/pane/agent-launch-pane-prompt'
import {
  refusedClaudeLaunchStartupsFor,
  withLaunchPanePromptDraft,
  type RefusedLaunchPaneHost,
  startRefusedPaneOnActiveClaudeAccount
} from './refused-claude-launch-recovery'

/** The refusal toast's "Start on active account": the refused pane again, or a new Claude tab. */
export function startPaneOnActiveClaudeAccount(input: {
  paneId: number
  paneHost: RefusedLaunchPaneHost
  worktreeId: string
  tabId: string
  restartPane: (paneId: number, startup: PtyPaneStartup) => void
}): void {
  startRefusedPaneOnActiveClaudeAccount({
    paneId: input.paneId,
    refusedStartups: refusedClaudeLaunchStartupsFor(input.paneHost),
    restartPane: (paneId, startup) =>
      input.restartPane(
        paneId,
        withLaunchPanePromptDraft(startup, agentLaunchPanePrompt(input.tabId))
      ),
    // Why no tab close: the old tab may hold live split siblings.
    openNewTab: () =>
      launchAgentInNewTabWithOutcome({
        requestId: createNonSecureContextUuid(),
        agent: 'claude',
        worktreeId: input.worktreeId,
        claudeAccountId: ACTIVE_CLAUDE_ACCOUNT,
        launchSource: 'unknown'
      })
  })
}
