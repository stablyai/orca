import { YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import type { AgentLaunchPreferences } from './agent-session-host-authority'
import type { AgentType } from './agent-status-types'
import {
  readLaunchPermissionChoice,
  agentPermissionHasTerminalChoice
} from './tui-agent-permission-choice'
import { isTuiAgent } from './tui-agent-config'
import { composeAgentLaunchModel } from './agent-session-option-launch'

/** Compose model/effort for this terminal; send permission mode only where the agent has a flag. */
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
  const mode = readLaunchPermissionChoice(sessionOptions)
  const preferences: AgentLaunchPreferences = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(mode && isTuiAgent(agent) && agentPermissionHasTerminalChoice(agent, mode) ? { mode } : {})
  }
  return Object.keys(preferences).length > 0 ? preferences : undefined
}

/** Authority v1 cannot carry a composed per-launch permission environment. */
export function agentPermissionNeedsPreparedCommand(
  agent: AgentType,
  applied: Readonly<Record<string, unknown>> | null | undefined
): boolean {
  return (
    Object.hasOwn(YOLO_TUI_AGENT_ENV, agent) && readLaunchPermissionChoice(applied) !== undefined
  )
}
