import { resolveTuiAgentLaunchArgs } from '../../../shared/tui-agent-launch-defaults'
import type { TuiAgent } from '../../../shared/tui-agent'

// Why: a launch action stores its blank arguments field verbatim, but the launchers only fall back
// to the agent's configured defaults on `undefined`, so a saved '' silently strips them (#19379).
// A null agent means the launcher picks one downstream, so blank becomes `undefined` and that
// launcher's own fallback resolves it. `undefined` always passes through untouched.
export function resolveSourceControlActionLaunchArgs(
  agent: TuiAgent | null,
  recipeAgentArgs: string | undefined,
  agentDefaultArgs: Partial<Record<TuiAgent, string>> | null | undefined
): string | undefined {
  if (recipeAgentArgs !== '') {
    return recipeAgentArgs
  }
  return agent ? resolveTuiAgentLaunchArgs(agent, agentDefaultArgs) : undefined
}
