import { describe, expect, it } from 'vitest'
import {
  buildAgentFeatureSkillHomeCommand,
  buildAgentFeatureSkillInstallCommand,
  buildAgentFeatureSkillUpdateCommand,
  COMPUTER_USE_SKILL_UPDATE_COMMAND,
  LINEAR_TICKETS_SKILL_UPDATE_COMMAND,
  ORCA_LINEAR_SKILL_UPDATE_COMMAND,
  ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_UPDATE_COMMAND,
  ORCHESTRATION_SKILL_UPDATE_COMMAND
} from './agent-feature-install-commands'

describe('agent feature skill commands', () => {
  // Why: `--global` silently skips the PromptScript target Orca consumes while
  // exiting 0, so the install/update commands must stay project-scoped.
  it('builds project-scoped single-skill install commands', () => {
    expect(buildAgentFeatureSkillInstallCommand(['orchestration'])).toBe(
      'npx skills add https://github.com/stablyai/orca --skill orchestration -y'
    )
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration'])).toBe(
      'npx skills add https://github.com/stablyai/orca --skill orca-cli orchestration -y'
    )
  })

  it('never emits the --global flag that masks the PromptScript failure', () => {
    expect(buildAgentFeatureSkillInstallCommand(['orchestration'])).not.toContain('--global')
    expect(buildAgentFeatureSkillUpdateCommand('orchestration')).not.toContain('--global')
  })

  it('builds single-skill update commands', () => {
    expect(buildAgentFeatureSkillUpdateCommand('orchestration')).toBe(
      'npx skills update orchestration'
    )
  })

  it('wraps copied project-scoped commands so they land in the home skill source', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orchestration'])

    expect(buildAgentFeatureSkillHomeCommand(installCommand, 'posix')).toBe(
      'cd "$HOME" && npx skills add https://github.com/stablyai/orca --skill orchestration -y'
    )
    expect(buildAgentFeatureSkillHomeCommand(installCommand, 'windows-powershell')).toBe(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -Path ~ -ErrorAction Stop; npx skills add https://github.com/stablyai/orca --skill orchestration -y"'
    )
  })

  it('rejects blank home-scoped commands', () => {
    expect(() => buildAgentFeatureSkillHomeCommand('  ', 'posix')).toThrow(
      'A skill command is required.'
    )
  })

  it('trims and rejects blank update skill names', () => {
    expect(buildAgentFeatureSkillUpdateCommand('  orca-cli  ')).toBe('npx skills update orca-cli')
    expect(() => buildAgentFeatureSkillUpdateCommand('   ')).toThrow('A skill name is required.')
  })

  it('exports single-skill update constants without changing install bundles', () => {
    expect(ORCA_CLI_SKILL_UPDATE_COMMAND).toBe('npx skills update orca-cli')
    expect(COMPUTER_USE_SKILL_UPDATE_COMMAND).toBe('npx skills update computer-use')
    expect(ORCHESTRATION_SKILL_UPDATE_COMMAND).toBe('npx skills update orchestration')
    expect(ORCA_LINEAR_SKILL_UPDATE_COMMAND).toBe('npx skills update orca-linear')
    expect(LINEAR_TICKETS_SKILL_UPDATE_COMMAND).toBe('npx skills update linear-tickets')
    expect(ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND).toBe(
      buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration'])
    )
  })
})
