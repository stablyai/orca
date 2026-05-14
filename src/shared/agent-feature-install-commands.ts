export type AgentFeatureSkillId = 'orca-cli' | 'computer-use' | 'orchestration'

export type AgentFeatureSkillInstallResult = {
  skillId: AgentFeatureSkillId
  command: string
  ok: boolean
  detail: string | null
}

export type AgentFeatureSkillInstallSummary = {
  results: AgentFeatureSkillInstallResult[]
}

const ORCA_SKILL_REPO = 'https://github.com/stablyai/orca'

export const ORCA_CLI_SKILL_INSTALL_COMMAND =
  'npx --yes skills add https://github.com/stablyai/orca --skill orca-cli --global --yes'

export const COMPUTER_USE_SKILL_INSTALL_COMMAND =
  'npx --yes skills add https://github.com/stablyai/orca --skill computer-use --global --yes'

export const ORCHESTRATION_SKILL_INSTALL_COMMAND =
  'npx --yes skills add https://github.com/stablyai/orca --skill orchestration --global --yes'

export const AGENT_FEATURE_SKILL_COMMANDS: Record<AgentFeatureSkillId, string> = {
  'orca-cli': ORCA_CLI_SKILL_INSTALL_COMMAND,
  'computer-use': COMPUTER_USE_SKILL_INSTALL_COMMAND,
  orchestration: ORCHESTRATION_SKILL_INSTALL_COMMAND
}

export const AGENT_FEATURE_SKILL_INSTALL_ARGS: Record<AgentFeatureSkillId, readonly string[]> = {
  'orca-cli': [
    '--yes',
    'skills',
    'add',
    ORCA_SKILL_REPO,
    '--skill',
    'orca-cli',
    '--global',
    '--yes'
  ],
  'computer-use': [
    '--yes',
    'skills',
    'add',
    ORCA_SKILL_REPO,
    '--skill',
    'computer-use',
    '--global',
    '--yes'
  ],
  orchestration: [
    '--yes',
    'skills',
    'add',
    ORCA_SKILL_REPO,
    '--skill',
    'orchestration',
    '--global',
    '--yes'
  ]
}

export function isAgentFeatureSkillId(value: unknown): value is AgentFeatureSkillId {
  return value === 'orca-cli' || value === 'computer-use' || value === 'orchestration'
}
