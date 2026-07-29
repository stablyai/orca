import { describe, expect, it } from 'vitest'
import {
  buildAgentFeatureSkillInstallArgs,
  buildAgentFeatureSkillInstallCommand,
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  buildAgentFeatureSkillUpdateArgs,
  buildAgentFeatureSkillUpdateCommand,
  COMPUTER_USE_SKILL_UPDATE_COMMAND,
  EPHEMERAL_VMS_SKILL_UPDATE_COMMAND,
  LINEAR_TICKETS_SKILL_UPDATE_COMMAND,
  ORCA_LINEAR_SKILL_UPDATE_COMMAND,
  ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_UPDATE_COMMAND,
  ORCHESTRATION_SKILL_UPDATE_COMMAND
} from './agent-feature-install-commands'

describe('agent feature skill commands', () => {
  it('builds a global install command by default', () => {
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli'])).toBe(
      'npx --yes skills add https://github.com/stablyai/orca --skill orca-cli --global -y'
    )
  })

  it('drops --global when installing locally', () => {
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli'], { global: false })).toBe(
      'npx --yes skills add https://github.com/stablyai/orca --skill orca-cli -y'
    )
  })

  it('repeats --skill per name for multi-skill installs', () => {
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration'])).toBe(
      'npx --yes skills add https://github.com/stablyai/orca --skill orca-cli --skill orchestration --global -y'
    )
    expect(buildAgentFeatureSkillInstallArgs(['orca-cli', 'orchestration'])).toEqual([
      '--yes',
      'skills',
      'add',
      'https://github.com/stablyai/orca',
      '--skill',
      'orca-cli',
      '--skill',
      'orchestration',
      '--global',
      '-y'
    ])
  })

  it('makes every install command non-interactive, pasted or spawned', () => {
    // Why: #9567 — a pasted install stalls on npm's fetch prompt and the skills
    // agent picker just as a spawned one does, so neither flag is opt-in.
    for (const command of [
      buildAgentFeatureSkillInstallCommand(['orca-cli']),
      ORCA_CLI_SKILL_INSTALL_COMMAND,
      ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND
    ]) {
      expect(command.startsWith('npx --yes skills add ')).toBe(true)
      expect(command.endsWith(' -y')).toBe(true)
    }
  })

  it('leaves the pasted update command parseable by the Windows reinstall rewrite', () => {
    // Why: normalizeWindowsSkillUpdateCommand matches exactly
    // `npx skills update <name> --global`; extra flags stop it matching and
    // silently disable the native-Windows workaround.
    const windowsRewrite = /^npx\s+skills\s+update\s+([A-Za-z0-9_-]+)\s+--global$/i
    expect(ORCA_CLI_SKILL_UPDATE_COMMAND).toMatch(windowsRewrite)
    expect(buildAgentFeatureSkillUpdateCommand('orca-cli')).toMatch(windowsRewrite)

    // Why: the CLI spawns it with nothing able to answer, so it opts in.
    expect(buildAgentFeatureSkillUpdateCommand(['orca-cli'], { yes: true })).toBe(
      'npx --yes skills update orca-cli --global -y'
    )
    expect(buildAgentFeatureSkillUpdateArgs(['orca-cli'], { global: false, yes: true })).toEqual([
      '--yes',
      'skills',
      'update',
      'orca-cli',
      '--project',
      '-y'
    ])
  })

  it('builds single-skill update commands', () => {
    expect(buildAgentFeatureSkillUpdateCommand('orchestration')).toBe(
      'npx skills update orchestration --global'
    )
  })

  it('trims and rejects blank update skill names', () => {
    expect(buildAgentFeatureSkillUpdateCommand('  orca-cli  ')).toBe(
      'npx skills update orca-cli --global'
    )
    expect(() => buildAgentFeatureSkillUpdateCommand('   ')).toThrow('A skill name is required.')
  })

  it('builds multi-skill update commands and selects project scope for --local', () => {
    expect(buildAgentFeatureSkillUpdateCommand(['orca-cli', 'orchestration'])).toBe(
      'npx skills update orca-cli orchestration --global'
    )
    expect(buildAgentFeatureSkillUpdateCommand(['orca-cli'], { global: false })).toBe(
      'npx skills update orca-cli --project'
    )
    expect(buildAgentFeatureSkillUpdateArgs(['orca-cli'], { global: false })).toEqual([
      'skills',
      'update',
      'orca-cli',
      '--project'
    ])
    expect(() => buildAgentFeatureSkillUpdateCommand([])).toThrow('A skill name is required.')
  })

  it('exports single-skill update constants without changing install bundles', () => {
    expect(ORCA_CLI_SKILL_UPDATE_COMMAND).toBe('npx skills update orca-cli --global')
    expect(COMPUTER_USE_SKILL_UPDATE_COMMAND).toBe('npx skills update computer-use --global')
    expect(ORCHESTRATION_SKILL_UPDATE_COMMAND).toBe('npx skills update orchestration --global')
    expect(EPHEMERAL_VMS_SKILL_UPDATE_COMMAND).toBe(
      'npx skills update orca-per-workspace-env --global'
    )
    expect(ORCA_LINEAR_SKILL_UPDATE_COMMAND).toBe('npx skills update orca-linear --global')
    expect(LINEAR_TICKETS_SKILL_UPDATE_COMMAND).toBe('npx skills update linear-tickets --global')
    expect(ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND).toBe(
      buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration'])
    )
  })
})
