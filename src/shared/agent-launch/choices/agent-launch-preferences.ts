import { YOLO_TUI_AGENT_ENV } from '../permissions/tui-agent-permissions'
import type { AgentLaunchPreferences } from '../../agent-session/lifecycle/operations/agent-session-host-authority'
import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import {
  readLaunchPermissionChoice,
  agentPermissionHasTerminalChoice
} from '../permissions/tui-agent-permission-choice'
import { isTuiAgent } from '../catalog/tui-agent-config'
import { AGENT_COPY_OPTION_ID, agentCopyIdFromOptions } from '../catalog/agent-copies'
import {
  composeAgentLaunchModel,
  hasIndependentAgentLaunchOptions
} from '../../agent-session/options/launch/agent-session-option-launch'

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
    typeof sessionOptions.effort === 'string' &&
    sessionOptions.effort.trim() &&
    !(agent === 'claude' && sessionOptions.effort.trim() === 'ultracode')
      ? sessionOptions.effort.trim()
      : undefined
  const mode = readLaunchPermissionChoice(sessionOptions)
  const agentCopy = agentCopyIdFromOptions(sessionOptions)
  const preferences: AgentLaunchPreferences = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(mode && isTuiAgent(agent) && agentPermissionHasTerminalChoice(agent, mode) ? { mode } : {}),
    ...(agentCopy ? { agentCopy } : {})
  }
  return Object.keys(preferences).length > 0 ? preferences : undefined
}

/** Older authority compilers lose effort-only choices and cannot carry permission environments. */
export function agentLaunchNeedsPreparedCommand(
  agent: AgentType,
  applied: Readonly<Record<string, unknown>> | null | undefined
): boolean {
  return (
    (Object.hasOwn(YOLO_TUI_AGENT_ENV, agent) &&
      readLaunchPermissionChoice(applied) !== undefined) ||
    (typeof applied?.effort === 'string' && !!applied.effort.trim() && !applied.model) ||
    (!!applied && hasIndependentAgentLaunchOptions(agent, applied))
  )
}

export const agentPermissionNeedsPreparedCommand = agentLaunchNeedsPreparedCommand

export function toAgentSessionOptionValues(values: Readonly<Record<string, unknown>> | undefined) {
  return values === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(values).filter(
          (entry): entry is [string, string | boolean] =>
            typeof entry[1] === 'string' || typeof entry[1] === 'boolean'
        )
      )
}

/** Session options for typed launch preferences; the copy rides under its reserved option id. */
export function agentLaunchPreferenceOptions(
  preferences: AgentLaunchPreferences | undefined
): Record<string, string> | undefined {
  if (!preferences) {
    return undefined
  }
  const options = {
    ...(preferences.model ? { model: preferences.model } : {}),
    ...(preferences.effort ? { effort: preferences.effort } : {}),
    ...(preferences.mode ? { mode: preferences.mode } : {}),
    ...(preferences.agentCopy ? { [AGENT_COPY_OPTION_ID]: preferences.agentCopy } : {})
  }
  return Object.keys(options).length > 0 ? options : undefined
}
