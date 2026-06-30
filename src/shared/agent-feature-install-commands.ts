export const ORCA_SKILLS_REPOSITORY_URL = 'https://github.com/stablyai/orca'

export const ORCA_CLI_SKILL_NAME = 'orca-cli'
export const COMPUTER_USE_SKILL_NAME = 'computer-use'
export const ORCHESTRATION_SKILL_NAME = 'orchestration'
export const ORCA_LINEAR_SKILL_NAME = 'orca-linear'
export const LINEAR_TICKETS_SKILL_NAME = 'linear-tickets'
export const LINEAR_AGENT_SKILL_NAMES = [ORCA_LINEAR_SKILL_NAME, LINEAR_TICKETS_SKILL_NAME] as const

export type AgentFeatureSkillCommandShell = 'posix' | 'windows-powershell'

export function buildAgentFeatureSkillInstallCommand(skillNames: readonly string[]): string {
  if (skillNames.length === 0) {
    throw new Error('At least one skill name is required.')
  }
  // Why: `--global` skips the PromptScript target (the one Orca consumes) yet
  // still exits 0, so installs silently never land. Project-scoped installs to
  // <cwd>/.agents/skills succeed for every target; setup surfaces wrap this
  // inner command so <cwd> is the user's home (a scanned 'home' source).
  // `-y` keeps the auto-run terminal non-interactive.
  return `npx skills add ${ORCA_SKILLS_REPOSITORY_URL} --skill ${skillNames.join(' ')} -y`
}

export function buildAgentFeatureSkillUpdateCommand(skillName: string): string {
  const trimmedSkillName = skillName.trim()
  if (!trimmedSkillName) {
    throw new Error('A skill name is required.')
  }
  // Why: must stay project-scoped to match the install above; a `--global`
  // update would target an install that never happened.
  return `npx skills update ${trimmedSkillName}`
}

function quotePowerShellDouble(value: string): string {
  return value.replace(/[`"$]/g, (match) => `\`${match}`)
}

export function buildAgentFeatureSkillHomeCommand(
  command: string,
  shell: AgentFeatureSkillCommandShell
): string {
  const trimmedCommand = command.trim()
  if (!trimmedCommand) {
    throw new Error('A skill command is required.')
  }

  // Why: `skills add` installs under the process cwd; force copied/pasted
  // setup commands into the user's home so Orca's home-source discovery sees
  // the PromptScript target no matter where the terminal was opened.
  if (shell === 'windows-powershell') {
    const command = `Set-Location -Path ~ -ErrorAction Stop; ${quotePowerShellDouble(
      trimmedCommand
    )}`
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${command}"`
  }
  return `cd "$HOME" && ${trimmedCommand}`
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
