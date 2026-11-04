import { isPinnableClaudeAccountId } from '../../../shared/claude/project-claude-account-preference'
import type {
  AgentLaunchRouteArgs,
  AgentLaunchRouteStore,
  buildAgentLaunchRouteInput
} from '@/lib/agent-launch-route-input'
import { resolveAgentLaunchRoute, type AgentLaunchRoute } from '@/lib/agent-launch-routing'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
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

export function resolvePlannedRoute(
  store: AgentLaunchRouteStore,
  request: ClaudeAccountRouteArgs & { requestedSurface?: AgentLaunchSurface },
  input: ReturnType<typeof buildAgentLaunchRouteInput>
): AgentLaunchRoute {
  const route = request.requestedSurface
    ? request.requestedSurface === 'chat'
      ? 'structured-native-chat'
      : 'terminal-tui'
    : resolveAgentLaunchRoute(input)
  // Why even over a requested chat: a chat cannot run on the pinned account, and must not run on another.
  return route === 'structured-native-chat' && launchPinsClaudeAccount(store, request)
    ? 'terminal-tui'
    : route
}
