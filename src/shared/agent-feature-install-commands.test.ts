import { describe, expect, it } from 'vitest'
import {
  buildAgentFeatureSkillInstallArgs,
  buildAgentFeatureSkillInstallCommand,
  MCODE_CLI_SKILL_INSTALL_COMMAND,
  buildAgentFeatureSkillUpdateArgs,
  buildAgentFeatureSkillUpdateCommand,
  COMPUTER_USE_SKILL_UPDATE_COMMAND,
  EPHEMERAL_VMS_SKILL_UPDATE_COMMAND,
  LINEAR_TICKETS_SKILL_UPDATE_COMMAND,
  MCODE_LINEAR_SKILL_UPDATE_COMMAND,
  MCODE_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND,
  MCODE_CLI_SKILL_UPDATE_COMMAND,
  ORCHESTRATION_SKILL_UPDATE_COMMAND
} from './agent-feature-install-commands'

describe('agent feature skill commands', () => {
  it('builds a global install command by default', () => {
    expect(buildAgentFeatureSkillInstallCommand(['mcode-cli'])).toBe(
      'npx skills add https://github.com/mcode-ide/mcode --skill mcode-cli --global'
    )
  })

  it('drops --global when installing locally', () => {
    expect(buildAgentFeatureSkillInstallCommand(['mcode-cli'], { global: false })).toBe(
      'npx skills add https://github.com/mcode-ide/mcode --skill mcode-cli'
    )
  })

  it('repeats --skill per name for multi-skill installs', () => {
    expect(buildAgentFeatureSkillInstallCommand(['mcode-cli', 'orchestration'])).toBe(
      'npx skills add https://github.com/mcode-ide/mcode --skill mcode-cli --skill orchestration --global'
    )
    expect(buildAgentFeatureSkillInstallArgs(['mcode-cli', 'orchestration'])).toEqual([
      'skills',
      'add',
      'https://github.com/mcode-ide/mcode',
      '--skill',
      'mcode-cli',
      '--skill',
      'orchestration',
      '--global'
    ])
  })

  it('keeps the copyable Settings commands interactive by default', () => {
    // Why: -y skips the agent picker. A human pasting from Settings should still
    // get it; only an unattended spawn opts in.
    expect(buildAgentFeatureSkillInstallCommand(['mcode-cli'])).not.toContain('-y')
    expect(buildAgentFeatureSkillUpdateCommand('mcode-cli')).not.toContain('-y')
    expect(MCODE_CLI_SKILL_INSTALL_COMMAND).not.toContain('-y')
    expect(MCODE_CLI_SKILL_UPDATE_COMMAND).not.toContain('-y')
  })

  it('refuses to skip prompts without an install target', () => {
    // Why: -y with no --agent is the one combination that makes `skills add`
    // install into every agent it knows (~75). No caller may express it.
    expect(() => buildAgentFeatureSkillInstallCommand(['mcode-cli'], { yes: true })).toThrow(
      'An install target is required when skipping prompts.'
    )
  })

  it('refuses a target the skills CLI would drop', () => {
    // Why: defence in depth behind the CLI's own check — the skills CLI silently
    // drops a `-`-leading --agent value, which empties its target list and
    // installs into every agent it knows.
    expect(() =>
      buildAgentFeatureSkillInstallCommand(['mcode-cli'], { yes: true, agents: ['-y'] })
    ).toThrow('"-y" is not a usable install target.')
    expect(() =>
      buildAgentFeatureSkillInstallArgs(['mcode-cli'], { yes: true, agents: ['universal', 'a b'] })
    ).toThrow('"a b" is not a usable install target.')
  })

  it('appends -y and the targets for an unattended run', () => {
    expect(
      buildAgentFeatureSkillInstallCommand(['mcode-cli'], { yes: true, agents: ['universal'] })
    ).toBe(
      'npx skills add https://github.com/mcode-ide/mcode --skill mcode-cli --global --agent universal -y'
    )
    expect(buildAgentFeatureSkillUpdateCommand(['mcode-cli'], { global: false, yes: true })).toBe(
      'npx skills update mcode-cli --project -y'
    )
    expect(
      buildAgentFeatureSkillInstallArgs(['mcode-cli'], { yes: true, agents: ['universal'] }).at(-1)
    ).toBe('-y')
    expect(buildAgentFeatureSkillUpdateArgs(['mcode-cli'], { yes: true }).at(-1)).toBe('-y')
  })

  it('builds single-skill update commands', () => {
    expect(buildAgentFeatureSkillUpdateCommand('orchestration')).toBe(
      'npx skills update orchestration --global'
    )
  })

  it('trims and rejects blank update skill names', () => {
    expect(buildAgentFeatureSkillUpdateCommand('  mcode-cli  ')).toBe(
      'npx skills update mcode-cli --global'
    )
    expect(() => buildAgentFeatureSkillUpdateCommand('   ')).toThrow('A skill name is required.')
  })

  it('builds multi-skill update commands and selects project scope for --local', () => {
    expect(buildAgentFeatureSkillUpdateCommand(['mcode-cli', 'orchestration'])).toBe(
      'npx skills update mcode-cli orchestration --global'
    )
    expect(buildAgentFeatureSkillUpdateCommand(['mcode-cli'], { global: false })).toBe(
      'npx skills update mcode-cli --project'
    )
    expect(buildAgentFeatureSkillUpdateArgs(['mcode-cli'], { global: false })).toEqual([
      'skills',
      'update',
      'mcode-cli',
      '--project'
    ])
    expect(() => buildAgentFeatureSkillUpdateCommand([])).toThrow('A skill name is required.')
  })

  it('exports single-skill update constants without changing install bundles', () => {
    expect(MCODE_CLI_SKILL_UPDATE_COMMAND).toBe('npx skills update mcode-cli --global')
    expect(COMPUTER_USE_SKILL_UPDATE_COMMAND).toBe('npx skills update computer-use --global')
    expect(ORCHESTRATION_SKILL_UPDATE_COMMAND).toBe('npx skills update orchestration --global')
    expect(EPHEMERAL_VMS_SKILL_UPDATE_COMMAND).toBe(
      'npx skills update mcode-per-workspace-env --global'
    )
    expect(MCODE_LINEAR_SKILL_UPDATE_COMMAND).toBe('npx skills update mcode-linear --global')
    expect(LINEAR_TICKETS_SKILL_UPDATE_COMMAND).toBe('npx skills update linear-tickets --global')
    expect(MCODE_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND).toBe(
      buildAgentFeatureSkillInstallCommand(['mcode-cli', 'orchestration'])
    )
  })
})
