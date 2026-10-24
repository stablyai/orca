import { agentPermissionHostPlatform, permissionEnvNameMatches } from './agent-permission-env'
import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import type { GlobalSettings } from './global-settings-types'
import {
  agentPermissionArgs,
  agentPermissionChoices,
  agentPermissionEnv,
  hasTypedAgentPermission,
  normalizeAgentPermissionOverrides,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'
import { permissionRecipeCut } from './agent-permission-args'
export { agentArgsSetPermission } from './agent-permission-args'
import type { TuiAgent } from './tui-agent'

/** Only exact recipes with preserved shell words and CLI ownership become stored intent. */
export function liftAgentPermissionArgs(
  agent: TuiAgent,
  text: string | null | undefined
): { choice: AgentChatPermissionMode | null; args: string } {
  const original = text?.trim() ?? ''
  for (const choice of agentPermissionChoices(agent)) {
    if (choice === 'own') {
      continue
    }
    const cut = permissionRecipeCut(agent, original, agentPermissionArgs(agent, choice))
    if (cut) {
      return { choice, args: cut.args }
    }
  }
  return { choice: null, args: original }
}

/**
 * Splits an env-driven bypass (Goose's `GOOSE_MODE=auto`) out of an environment record. Names
 * follow the execution host's identity; unknown browser caches preserve ambiguous spellings.
 */
export function liftAgentPermissionEnv(
  agent: TuiAgent,
  env: Record<string, string> | null | undefined,
  platform: NodeJS.Platform | null | undefined = agentPermissionHostPlatform()
): { choice: 'full-access' | null; env: Record<string, string> } {
  const rest = { ...env }
  const bypass = Object.entries(agentPermissionEnv(agent, 'full-access'))
  const matches = (name: string, wanted: string): boolean =>
    permissionEnvNameMatches(name, wanted, platform)
  const setsBypass = ([wanted, value]: [string, string]): boolean => {
    const spellings = Object.entries(rest).filter(([name]) => matches(name, wanted))
    return (
      spellings.length > 0 &&
      spellings.every(([, current]) => current === value) &&
      (platform != null ||
        !Object.keys(rest).some(
          (name) => name !== wanted && name.toLowerCase() === wanted.toLowerCase()
        ))
    )
  }
  if (bypass.length === 0 || !bypass.every(setsBypass)) {
    return { choice: null, env: rest }
  }
  for (const name of Object.keys(rest)) {
    if (bypass.some(([wanted]) => matches(name, wanted))) {
      delete rest[name]
    }
  }
  return { choice: 'full-access', env: rest }
}

type AgentPermissionProfile = Required<
  Pick<
    GlobalSettings,
    'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionDefault' | 'agentPermissionOverrides'
  >
>

/**
 * Moves each agent's permission out of its Arguments into a stored choice, once per profile.
 * Orca's own flags become the choice and leave the text; no flag means the agent's own settings
 * (those terminals passed none). Text that sets permissions some other way is left whole, on own.
 */
export function migrateAgentPermissionChoice(
  settings: Partial<AgentPermissionProfile>,
  platform: NodeJS.Platform | null | undefined = agentPermissionHostPlatform()
): AgentPermissionProfile {
  const args = { ...settings.agentDefaultArgs }
  const env = { ...settings.agentDefaultEnv }
  if (hasTypedAgentPermission(settings)) {
    return {
      agentDefaultArgs: args,
      agentDefaultEnv: env,
      agentPermissionDefault: settings.agentPermissionDefault ?? 'own',
      agentPermissionOverrides: normalizeAgentPermissionOverrides(settings.agentPermissionOverrides)
    }
  }
  const choices = new Map<TuiAgent, AgentPermissionChoice>()
  const counts = new Map<AgentPermissionChoice, number>()
  for (const agent of PERMISSION_CHOICE_AGENTS) {
    const fromArgs = liftAgentPermissionArgs(agent, args[agent])
    const fromEnv = fromArgs.choice ? null : liftAgentPermissionEnv(agent, env[agent], platform)
    if (fromArgs.choice) {
      args[agent] = fromArgs.args
    } else if (fromEnv?.choice && env[agent]) {
      env[agent] = fromEnv.env
    }
    const choice = fromArgs.choice ?? fromEnv?.choice ?? 'own'
    choices.set(agent, choice)
    counts.set(choice, (counts.get(choice) ?? 0) + 1)
  }
  // The most common choice becomes the all-agents one; ties keep the first counted.
  let agentPermissionDefault: AgentPermissionChoice = 'own'
  for (const [choice, count] of counts) {
    if (count > (counts.get(agentPermissionDefault) ?? 0)) {
      agentPermissionDefault = choice
    }
  }
  const agentPermissionOverrides: Partial<Record<TuiAgent, AgentPermissionChoice>> = {}
  for (const [agent, choice] of choices) {
    if (resolveAgentPermission(agent, { agentPermissionDefault }).choice !== choice) {
      agentPermissionOverrides[agent] = choice
    }
  }
  return {
    agentDefaultArgs: args,
    agentDefaultEnv: env,
    agentPermissionDefault,
    agentPermissionOverrides
  }
}
