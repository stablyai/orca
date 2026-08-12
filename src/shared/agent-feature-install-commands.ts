import type { TuiAgent } from './types'
import {
  isSkillsCliAgentKeyShaped,
  toSkillsCliAgentKeys
} from './skills-cli-agent-keys'

export const ORCA_SKILLS_REPOSITORY_URL = 'https://github.com/stablyai/orca'

export const ORCA_CLI_SKILL_NAME = 'orca-cli'
export const COMPUTER_USE_SKILL_NAME = 'computer-use'
export const ORCHESTRATION_SKILL_NAME = 'orchestration'
export const EPHEMERAL_VMS_SKILL_NAME = 'orca-per-workspace-env'
export const ORCA_LINEAR_SKILL_NAME = 'orca-linear'
export const LINEAR_TICKETS_SKILL_NAME = 'linear-tickets'
export const LINEAR_AGENT_SKILL_NAMES = [ORCA_LINEAR_SKILL_NAME, LINEAR_TICKETS_SKILL_NAME] as const

// Why: the raw builder still defaults interactive so callers can paste a
// detection-driven prompt when a human is answering. Settings/onboarding UI
// strings and the CLI path use the unattended builders — an inline PTY and a
// headless host both hang forever on the skills agent picker without -y (#13542).
export type AgentFeatureSkillCommandOptions = {
  global?: boolean
  yes?: boolean
  agents?: readonly string[]
}

export function buildAgentFeatureSkillInstallArgs(
  skillNames: readonly string[],
  options: AgentFeatureSkillCommandOptions = {}
): string[] {
  if (skillNames.length === 0) {
    throw new Error('At least one skill name is required.')
  }
  const global = options.global ?? true
  // Why: -y with no --agent is the one combination that makes `skills add` install
  // into every agent it knows. Refuse it here so no caller can express it.
  const agents = options.agents ?? []
  if (options.yes && agents.length === 0) {
    throw new Error('An install target is required when skipping prompts.')
  }
  // Why: a value the skills CLI would drop leaves it with no target at all, which
  // is the same all-agents install as passing no --agent.
  const unusable = agents.find((agent) => !isSkillsCliAgentKeyShaped(agent))
  if (unusable !== undefined) {
    throw new Error(`"${unusable}" is not a usable install target.`)
  }
  // Why: one flag per name remains compatible with both single-value and variadic parsers.
  const skillArgs = skillNames.flatMap((name) => ['--skill', name])
  return [
    'skills',
    'add',
    ORCA_SKILLS_REPOSITORY_URL,
    ...skillArgs,
    ...(global ? ['--global'] : []),
    // Why: an explicit --agent stops `skills add` calling its own detection, whose
    // zero-detected branch installs into all ~75 known agents and litters a bare
    // host with agent config directories it has no agent for.
    ...agents.flatMap((agent) => ['--agent', agent]),
    // Why: without -y `skills add` opens an interactive agent picker and blocks
    // forever on any TTY, which is every ssh session.
    ...(options.yes ? ['-y'] : [])
  ]
}

export function buildAgentFeatureSkillInstallCommand(
  skillNames: readonly string[],
  options: AgentFeatureSkillCommandOptions = {}
): string {
  return `npx ${buildAgentFeatureSkillInstallArgs(skillNames, options).join(' ')}`
}

/**
 * Install command for paths nothing can answer (Settings inline terminal, CLI,
 * SSH paste). Always pairs `-y` with mapped `--agent` keys (at least `universal`)
 * so the skills CLI never opens the agent picker or the all-agents install.
 */
export function buildUnattendedAgentFeatureSkillInstallCommand(
  skillNames: readonly string[],
  options: {
    global?: boolean
    detectedAgents?: readonly TuiAgent[]
  } = {}
): string {
  return buildAgentFeatureSkillInstallCommand(skillNames, {
    global: options.global,
    yes: true,
    agents: toSkillsCliAgentKeys(options.detectedAgents ?? [])
  })
}

export function buildAgentFeatureSkillUpdateArgs(
  skillNames: string | readonly string[],
  options: AgentFeatureSkillCommandOptions = {}
): string[] {
  const rawNames = typeof skillNames === 'string' ? [skillNames] : skillNames
  const names = rawNames.map((name) => name.trim()).filter((name) => name.length > 0)
  if (names.length === 0) {
    throw new Error('A skill name is required.')
  }
  const global = options.global ?? true
  return [
    'skills',
    'update',
    ...names,
    global ? '--global' : '--project',
    ...(options.yes ? ['-y'] : [])
  ]
}

export function buildAgentFeatureSkillUpdateCommand(
  skillNames: string | readonly string[],
  options: AgentFeatureSkillCommandOptions = {}
): string {
  return `npx ${buildAgentFeatureSkillUpdateArgs(skillNames, options).join(' ')}`
}

/** Update command for unattended UI/CLI paths — skip the skills confirmation prompt. */
export function buildUnattendedAgentFeatureSkillUpdateCommand(
  skillNames: string | readonly string[],
  options: { global?: boolean } = {}
): string {
  return buildAgentFeatureSkillUpdateCommand(skillNames, { ...options, yes: true })
}

export const ORCA_CLI_SKILL_INSTALL_COMMAND = buildUnattendedAgentFeatureSkillInstallCommand([
  ORCA_CLI_SKILL_NAME
])

export const ORCA_CLI_SKILL_UPDATE_COMMAND =
  buildUnattendedAgentFeatureSkillUpdateCommand(ORCA_CLI_SKILL_NAME)

export const COMPUTER_USE_SKILL_INSTALL_COMMAND = buildUnattendedAgentFeatureSkillInstallCommand([
  COMPUTER_USE_SKILL_NAME
])

export const COMPUTER_USE_SKILL_UPDATE_COMMAND =
  buildUnattendedAgentFeatureSkillUpdateCommand(COMPUTER_USE_SKILL_NAME)

export const ORCHESTRATION_SKILL_INSTALL_COMMAND = buildUnattendedAgentFeatureSkillInstallCommand([
  ORCHESTRATION_SKILL_NAME
])

export const ORCHESTRATION_SKILL_UPDATE_COMMAND =
  buildUnattendedAgentFeatureSkillUpdateCommand(ORCHESTRATION_SKILL_NAME)

export const EPHEMERAL_VMS_SKILL_INSTALL_COMMAND = buildUnattendedAgentFeatureSkillInstallCommand([
  EPHEMERAL_VMS_SKILL_NAME
])

export const EPHEMERAL_VMS_SKILL_UPDATE_COMMAND =
  buildUnattendedAgentFeatureSkillUpdateCommand(EPHEMERAL_VMS_SKILL_NAME)

export const ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND =
  buildUnattendedAgentFeatureSkillInstallCommand([ORCA_CLI_SKILL_NAME, ORCHESTRATION_SKILL_NAME])

export const ORCA_LINEAR_SKILL_INSTALL_COMMAND = buildUnattendedAgentFeatureSkillInstallCommand([
  ORCA_LINEAR_SKILL_NAME
])

export const ORCA_LINEAR_SKILL_UPDATE_COMMAND =
  buildUnattendedAgentFeatureSkillUpdateCommand(ORCA_LINEAR_SKILL_NAME)

export const LINEAR_TICKETS_SKILL_UPDATE_COMMAND =
  buildUnattendedAgentFeatureSkillUpdateCommand(LINEAR_TICKETS_SKILL_NAME)
