export const ORCA_SKILLS_REPOSITORY_URL = 'https://github.com/stablyai/orca'

export const ORCA_CLI_SKILL_NAME = 'orca-cli'
export const COMPUTER_USE_SKILL_NAME = 'computer-use'
export const ORCHESTRATION_SKILL_NAME = 'orchestration'
export const EPHEMERAL_VMS_SKILL_NAME = 'orca-per-workspace-env'
export const ORCA_LINEAR_SKILL_NAME = 'orca-linear'
export const LINEAR_TICKETS_SKILL_NAME = 'linear-tickets'
export const LINEAR_AGENT_SKILL_NAMES = [ORCA_LINEAR_SKILL_NAME, LINEAR_TICKETS_SKILL_NAME] as const

/** Full `npx` argv, so a spawned run and a pasted string can never diverge. */
export function buildAgentFeatureSkillInstallArgs(
  skillNames: readonly string[],
  options: { global?: boolean } = {}
): string[] {
  if (skillNames.length === 0) {
    throw new Error('At least one skill name is required.')
  }
  const global = options.global ?? true
  // Why: one flag per name. The variadic `--skill a b` form silently drops names
  // the repo does not have — it exits 0 having installed only the matches.
  const skillArgs = skillNames.flatMap((name) => ['--skill', name])
  // Why: both flags are load-bearing wherever this runs (#9567). `npx --yes`
  // skips npm's fetch prompt on a cold cache; `skills … -y` skips the agent
  // picker, which otherwise blocks forever on any TTY and on a pasted install.
  return [
    '--yes',
    'skills',
    'add',
    ORCA_SKILLS_REPOSITORY_URL,
    ...skillArgs,
    ...(global ? ['--global'] : []),
    '-y'
  ]
}

export function buildAgentFeatureSkillInstallCommand(
  skillNames: readonly string[],
  options: { global?: boolean } = {}
): string {
  return `npx ${buildAgentFeatureSkillInstallArgs(skillNames, options).join(' ')}`
}

export function buildAgentFeatureSkillUpdateArgs(
  skillNames: string | readonly string[],
  options: { global?: boolean; yes?: boolean } = {}
): string[] {
  const rawNames = typeof skillNames === 'string' ? [skillNames] : skillNames
  const names = rawNames.map((name) => name.trim()).filter((name) => name.length > 0)
  if (names.length === 0) {
    throw new Error('A skill name is required.')
  }
  const global = options.global ?? true
  const scope = global ? '--global' : '--project'
  // Why: `yes` is opt-in here, unlike install, because the pasted update string
  // must stay exactly `npx skills update <name> --global` —
  // normalizeWindowsSkillUpdateCommand parses that shape to swap in a reinstall
  // on native Windows, and the extra flags stop it matching.
  return options.yes
    ? ['--yes', 'skills', 'update', ...names, scope, '-y']
    : ['skills', 'update', ...names, scope]
}

export function buildAgentFeatureSkillUpdateCommand(
  skillNames: string | readonly string[],
  options: { global?: boolean; yes?: boolean } = {}
): string {
  return `npx ${buildAgentFeatureSkillUpdateArgs(skillNames, options).join(' ')}`
}

export const ORCA_CLI_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  ORCA_CLI_SKILL_NAME
])

export const ORCA_CLI_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(ORCA_CLI_SKILL_NAME)

export const COMPUTER_USE_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  COMPUTER_USE_SKILL_NAME
])

export const COMPUTER_USE_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(COMPUTER_USE_SKILL_NAME)

export const ORCHESTRATION_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  ORCHESTRATION_SKILL_NAME
])

export const ORCHESTRATION_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(ORCHESTRATION_SKILL_NAME)

export const EPHEMERAL_VMS_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  EPHEMERAL_VMS_SKILL_NAME
])

export const EPHEMERAL_VMS_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(EPHEMERAL_VMS_SKILL_NAME)

export const ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  ORCA_CLI_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
])

export const ORCA_LINEAR_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  ORCA_LINEAR_SKILL_NAME
])

export const ORCA_LINEAR_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(ORCA_LINEAR_SKILL_NAME)

export const LINEAR_TICKETS_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  LINEAR_TICKETS_SKILL_NAME
])

export const LINEAR_TICKETS_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(LINEAR_TICKETS_SKILL_NAME)
