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
      'npx skills add https://github.com/stablyai/orca --skill orca-cli --global'
    )
  })

  it('drops --global when installing locally', () => {
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli'], { global: false })).toBe(
      'npx skills add https://github.com/stablyai/orca --skill orca-cli'
    )
  })

  it('repeats --skill per name for multi-skill installs', () => {
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration'])).toBe(
      'npx skills add https://github.com/stablyai/orca --skill orca-cli --skill orchestration --global'
    )
    expect(buildAgentFeatureSkillInstallArgs(['orca-cli', 'orchestration'])).toEqual([
      'skills',
      'add',
      'https://github.com/stablyai/orca',
      '--skill',
      'orca-cli',
      '--skill',
      'orchestration',
      '--global'
    ])
  })

  it('keeps the copyable Settings commands interactive by default', () => {
    // Why: -y skips the agent picker. A human pasting from Settings should still
    // get it; only an unattended spawn opts in.
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli'])).not.toContain('-y')
    expect(buildAgentFeatureSkillUpdateCommand('orca-cli')).not.toContain('-y')
    expect(ORCA_CLI_SKILL_INSTALL_COMMAND).not.toContain('-y')
    expect(ORCA_CLI_SKILL_UPDATE_COMMAND).not.toContain('-y')
  })

  it('refuses to skip prompts without an install target', () => {
    // Why: -y with no --agent is the one combination that makes `skills add`
    // install into every agent it knows (~75). No caller may express it.
    expect(() => buildAgentFeatureSkillInstallCommand(['orca-cli'], { yes: true })).toThrow(
      'An install target is required when skipping prompts.'
    )
  })

  it('refuses a target the skills CLI would drop', () => {
    // Why: defence in depth behind the CLI's own check — the skills CLI silently
    // drops a `-`-leading --agent value, which empties its target list and
    // installs into every agent it knows.
    expect(() =>
      buildAgentFeatureSkillInstallCommand(['orca-cli'], { yes: true, agents: ['-y'] })
    ).toThrow('"-y" is not a usable install target.')
    expect(() =>
      buildAgentFeatureSkillInstallArgs(['orca-cli'], { yes: true, agents: ['universal', 'a b'] })
    ).toThrow('"a b" is not a usable install target.')
  })

  it('appends -y and the targets for an unattended run', () => {
    expect(
      buildAgentFeatureSkillInstallCommand(['orca-cli'], { yes: true, agents: ['universal'] })
    ).toBe(
      'npx skills add https://github.com/stablyai/orca --skill orca-cli --global --agent universal -y'
    )
    expect(buildAgentFeatureSkillUpdateCommand(['orca-cli'], { global: false, yes: true })).toBe(
      'npx skills update orca-cli --project -y'
    )
    expect(
      buildAgentFeatureSkillInstallArgs(['orca-cli'], { yes: true, agents: ['universal'] }).at(-1)
    ).toBe('-y')
    expect(buildAgentFeatureSkillUpdateArgs(['orca-cli'], { yes: true }).at(-1)).toBe('-y')
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
