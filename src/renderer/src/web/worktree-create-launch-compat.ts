// Client-side skew contract for worktree.create against a remote host (compat
// design: "old host × new client"). A pre-identity host's schema silently
// strips the unknown `agentLaunch` key (bare-terminal worktree), so the client
// probes `agent-launch.identity.v1` and falls back to the legacy host-resolved
// `startupAgent` id, mirroring the CLI's resolveWorktreeCreateLaunchParams.

import { isBuiltInTuiAgent } from '../../../shared/tui-agent-config'
import { translate } from '@/i18n/i18n'
import type { AgentLaunchSpawnRequest } from '../../../shared/agent-launch-spawn-request'

export type RemoteWorktreeCreateLaunchParams =
  | Record<string, never>
  | { agentLaunch: AgentLaunchSpawnRequest }
  | { startupAgent: string; startupPrompt: string }

export async function resolveRemoteWorktreeCreateLaunchParams(
  agentLaunch: AgentLaunchSpawnRequest | undefined,
  hostSupportsIdentity: () => Promise<boolean>
): Promise<RemoteWorktreeCreateLaunchParams> {
  if (!agentLaunch) {
    return {}
  }
  if (await hostSupportsIdentity()) {
    return { agentLaunch }
  }
  const selection = agentLaunch.selection
  // FAIL-FAST: a pre-identity host cannot resolve a stored default or a custom id.
  if (selection.kind !== 'agent') {
    throw new Error(
      translate(
        'auto.web.worktreeCreate.hostPredatesDefaultLaunch',
        'This Orca host predates default-agent launch. Pick a specific built-in agent or update Orca on the host.'
      )
    )
  }
  if (!isBuiltInTuiAgent(selection.agent)) {
    throw new Error(
      translate(
        'auto.web.worktreeCreate.hostPredatesCustomAgents',
        'This Orca host predates custom agents. Pick a built-in agent or update Orca on the host.'
      )
    )
  }
  return { startupAgent: selection.agent, startupPrompt: agentLaunch.prompt ?? '' }
}
