import { isPinnableClaudeAccountId } from '../../../shared/claude/project-claude-account-preference'
import type { AgentLaunchRouteArgs, AgentLaunchRouteStore } from '@/lib/agent-launch-route-input'
import { findLaunchRepo, resolveLaunchClaudeAccountId } from '@/lib/claude-launch-account'

export type ClaudeAccountRouteArgs = AgentLaunchRouteArgs & {
  /** A one-time account choice; the project's saved account applies when omitted. */
  claudeAccountId?: string
}

// Why: a structured session has no account-pinning path, so a pinned Claude launch runs in a terminal.
export function launchPinsClaudeAccount(
  store: AgentLaunchRouteStore,
  request: ClaudeAccountRouteArgs
): boolean {
  if (request.agent !== 'claude') {
    return false
  }
  const repo = findLaunchRepo(store, request.workspace)
  return isPinnableClaudeAccountId(resolveLaunchClaudeAccountId(repo, request.claudeAccountId))
}
