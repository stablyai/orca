import type { AgentLaunchPreferences } from './agent-session-host-authority'
import type { AgentType } from './agent-status-types'
import {
  readLaunchPermissionMode,
  terminalPermissionModeArgs
} from './agent-permission-mode-terminal-args'
import { composeAgentLaunchModel } from './agent-session-option-launch'

/** A launch's options as the model, effort and mode a terminal starts with, for the given agent.
 *  The model is composed as its argv composes it; model and effort pass on otherwise, because a
 *  paired host re-resolves them against its own, newer catalog. A mode rides only where this
 *  agent's terminal has a flag for it: released hosts refuse an OpenCode launch with any option. */
export function toAgentLaunchPreferences(
  sessionOptions: Readonly<Record<string, unknown>> | null | undefined,
  agent: AgentType
): AgentLaunchPreferences | undefined {
  if (!sessionOptions) {
    return undefined
  }
  const model = composeAgentLaunchModel(agent, sessionOptions)
  const effort =
    typeof sessionOptions.effort === 'string' && sessionOptions.effort.trim()
      ? sessionOptions.effort.trim()
      : undefined
  const mode = readLaunchPermissionMode(sessionOptions)
  const preferences: AgentLaunchPreferences = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(mode && terminalPermissionModeArgs(agent, mode) ? { mode } : {})
  }
  return Object.keys(preferences).length > 0 ? preferences : undefined
}
