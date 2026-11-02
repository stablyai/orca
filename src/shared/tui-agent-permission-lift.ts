import {
  AGENT_LAUNCH_CHOICE_KEYS,
  normalizeAgentLaunchChoices,
  normalizeAgentModelOptionChoices
} from './agent-launch-choices'
import { agentPermissionHostPlatform, permissionEnvNameMatches } from './agent-permission-env'
import type { GlobalSettings } from './global-settings-types'
import {
  agentPermissionEnv,
  hasTypedAgentPermission,
  normalizeAgentPermissionOverrides,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'
import { reconcileAgentChoiceArgs } from './agent-choice-reconciliation'
import { planAgentCliArgsSuffix, type AgentStartupShell } from './tui-agent-startup-shell'
export { agentArgsSetPermission } from './agent-permission-args'
import type { TuiAgent } from './tui-agent'

/** Only exact recipes with preserved shell words and CLI ownership become stored intent. */
export function liftAgentPermissionArgs(
  agent: TuiAgent,
  text: string | null | undefined
): { choice: AgentPermissionChoice | null; args: string } {
  const result = reconcileAgentChoiceArgs({
    agent,
    userArgs: text?.trim() ?? '',
    choices: {},
    mode: 'load',
    keys: new Set(['permissionMode'])
  })
  return { choice: result.choices.permissionMode ?? null, args: result.userArgs }
}

/** A recorded launch without Orca's permission flag; recorded text it cannot rebuild stays whole. */
export function dropRecordedAgentPermissionArgs(
  agent: TuiAgent,
  recorded: { agentArgs?: string | null; agentCommand?: string | null },
  shell: AgentStartupShell
): { agentArgs?: string | null; agentCommand?: string | null } {
  const lifted = liftAgentPermissionArgs(agent, recorded.agentArgs)
  if (!lifted.choice) {
    return recorded
  }
  const command = recorded.agentCommand?.trim()
  if (!command) {
    return { ...recorded, agentArgs: lifted.args }
  }
  const before = planAgentCliArgsSuffix(recorded.agentArgs, shell)
  const after = planAgentCliArgsSuffix(lifted.args, shell)
  if (!before.ok || !after.ok || !command.endsWith(` ${before.suffix}`)) {
    return recorded
  }
  const head = command.slice(0, -before.suffix.length).trimEnd()
  return { agentArgs: lifted.args, agentCommand: after.suffix ? `${head} ${after.suffix}` : head }
}

/** Lift env bypass with execution-host name casing; unknown browser caches retain ambiguous spellings. */
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
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
    | 'agentLaunchChoices'
    | 'agentPermissionDefault'
    | 'agentPermissionOverrides'
  >
>

/** Migrate exact Orca permission recipes once, preserving unrelated text on own; absent flags also mean own because those launches passed none. */
export function migrateAgentPermissionChoice(
  settings: Partial<AgentPermissionProfile>,
  platform: NodeJS.Platform | null | undefined = agentPermissionHostPlatform()
): AgentPermissionProfile {
  const args = { ...settings.agentDefaultArgs }
  const env = { ...settings.agentDefaultEnv }
  const typed = hasTypedAgentPermission(settings)
  const agentLaunchChoices = normalizeAgentLaunchChoices(settings.agentLaunchChoices)
  if (typed && settings.agentLaunchChoices !== undefined) {
    return {
      ...settings,
      agentDefaultArgs: args,
      agentDefaultEnv: env,
      agentLaunchChoices,
      agentPermissionDefault: settings.agentPermissionDefault ?? 'own',
      agentPermissionOverrides: normalizeAgentPermissionOverrides(settings.agentPermissionOverrides)
    }
  }
  const choices = new Map<TuiAgent, AgentPermissionChoice>()
  const counts = new Map<AgentPermissionChoice, number>()
  for (const agent of PERMISSION_CHOICE_AGENTS) {
    const result = reconcileAgentChoiceArgs({
      agent,
      userArgs: args[agent] ?? '',
      choices: {
        ...agentLaunchChoices[agent],
        ...(typed ? { permissionMode: resolveAgentPermission(agent, settings).choice } : {})
      },
      mode: 'load',
      keys:
        settings.agentLaunchChoices === undefined
          ? AGENT_LAUNCH_CHOICE_KEYS
          : new Set(['permissionMode'])
    })
    const model = normalizeAgentModelOptionChoices(result.choices)
    if (model) {
      agentLaunchChoices[agent] = model
    }
    if (args[agent] !== undefined || result.userArgs) {
      args[agent] = result.userArgs
    }
    const fromEnv =
      typed || result.choices.permissionMode
        ? null
        : liftAgentPermissionEnv(agent, env[agent], platform)
    if (fromEnv?.choice && env[agent]) {
      env[agent] = fromEnv.env
    }
    const choice = result.choices.permissionMode ?? fromEnv?.choice ?? 'own'
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
    agentLaunchChoices,
    agentPermissionDefault: typed
      ? (settings.agentPermissionDefault ?? 'own')
      : agentPermissionDefault,
    agentPermissionOverrides: typed
      ? normalizeAgentPermissionOverrides(settings.agentPermissionOverrides)
      : agentPermissionOverrides
  }
}
