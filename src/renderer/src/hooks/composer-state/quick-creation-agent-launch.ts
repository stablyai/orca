import type { AgentLaunchRouteArgs } from '@/lib/agent-launch-route-input'
import type { AgentLaunchRoute } from '@/lib/agent-launch-routing'
import { launchChoiceSurface, type AgentLaunchChoice } from '@/lib/agent-menu-selection'
import { resolveAgentSessionLaunchRoute } from '@/lib/agent-session-launch-plan'
import { findLaunchRepo, resolveLaunchClaudeAccountId } from '@/lib/claude-launch-account'
import { chooseClaudeLaunchAccountIdForRepo } from '@/components/claude-account-prompt/choose-claude-launch-account'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type QuickAgentLaunch = {
  /** The account the startup runs on: the prompt's pick, else the project's saved account. */
  claudeAccountId: string | undefined
  resolveRoute: (request: Omit<AgentLaunchRouteArgs, 'agent'>) => AgentLaunchRoute
}

/** Asks for the Claude account when the project wants one; null when the user cancelled. */
export async function prepareQuickAgentLaunch(
  agent: TuiAgent | null,
  repoId: string,
  launchChoice: AgentLaunchChoice | undefined
): Promise<QuickAgentLaunch | null> {
  const chosenAccountId =
    agent === 'claude' ? await chooseClaudeLaunchAccountIdForRepo(repoId) : undefined
  if (chosenAccountId === null) {
    return null
  }
  const repo = findLaunchRepo(useAppStore.getState(), { repoId })
  return {
    claudeAccountId: resolveLaunchClaudeAccountId(repo, chosenAccountId),
    resolveRoute: (request) =>
      !agent
        ? 'terminal-tui'
        : resolveAgentSessionLaunchRoute(useAppStore.getState(), {
            ...request,
            agent,
            claudeAccountId: chosenAccountId,
            // Why: the menu's pick stands, except that a pinned Claude account still needs a terminal.
            ...(launchChoice ? { requestedSurface: launchChoiceSurface(launchChoice) } : {})
          })
  }
}
