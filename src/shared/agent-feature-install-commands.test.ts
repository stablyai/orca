import { describe, expect, it } from 'vitest'
import {
  buildAgentFeatureSkillInstallArgs,
  buildAgentFeatureSkillInstallCommand,
  SKILLS_CLI_VERSION
} from './agent-feature-install-commands'

const sourceCommit = '0123456789abcdef0123456789abcdef01234567'
const source = `https://github.com/stablyai/orca/tree/${sourceCommit}`

describe('agent feature skill commands', () => {
  it('pins the skills CLI and the source to the build commit', () => {
    expect(buildAgentFeatureSkillInstallArgs(['orca-cli'], { sourceCommit }).slice(0, 3)).toEqual([
      `skills@${SKILLS_CLI_VERSION}`,
      'add',
      source
    ])
  })

  it('builds a global install command by default', () => {
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli'], { sourceCommit })).toBe(
      `npx skills@${SKILLS_CLI_VERSION} add ${source} --skill orca-cli --global`
    )
  })

  it('drops --global when installing locally', () => {
    expect(
      buildAgentFeatureSkillInstallCommand(['orca-cli'], { sourceCommit, global: false })
    ).toBe(`npx skills@${SKILLS_CLI_VERSION} add ${source} --skill orca-cli`)
  })

  it('repeats --skill per name for multi-skill installs', () => {
    expect(
      buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration'], { sourceCommit })
    ).toBe(
      `npx skills@${SKILLS_CLI_VERSION} add ${source} --skill orca-cli --skill orchestration --global`
    )
    expect(
      buildAgentFeatureSkillInstallArgs(['orca-cli', 'orchestration'], { sourceCommit })
    ).toEqual([
      `skills@${SKILLS_CLI_VERSION}`,
      'add',
      source,
      '--skill',
      'orca-cli',
      '--skill',
      'orchestration',
      '--global'
    ])
  })

  it('rejects an empty skill list', () => {
    expect(() => buildAgentFeatureSkillInstallArgs([], { sourceCommit })).toThrow(
      'At least one skill name is required.'
    )
  })

  it('keeps the copyable Settings commands interactive by default', () => {
    // Why: -y skips the agent picker. A human pasting from Settings should still
    // get it; only an unattended spawn opts in.
    expect(buildAgentFeatureSkillInstallCommand(['orca-cli'], { sourceCommit })).not.toContain('-y')
  })

  it('refuses to skip prompts without an install target', () => {
    // Why: -y with no --agent is the one combination that makes `skills add`
    // install into every agent it knows (~75). No caller may express it.
    expect(() =>
      buildAgentFeatureSkillInstallCommand(['orca-cli'], { sourceCommit, yes: true })
    ).toThrow('An install target is required when skipping prompts.')
  })

  it('refuses a target the skills CLI would drop', () => {
    // Why: defence in depth behind the CLI's own check — the skills CLI silently
    // drops a `-`-leading --agent value, which empties its target list and
    // installs into every agent it knows.
    expect(() =>
      buildAgentFeatureSkillInstallCommand(['orca-cli'], {
        sourceCommit,
        yes: true,
        agents: ['-y']
      })
    ).toThrow('"-y" is not a usable install target.')
    expect(() =>
      buildAgentFeatureSkillInstallArgs(['orca-cli'], {
        sourceCommit,
        yes: true,
        agents: ['universal', 'a b']
      })
    ).toThrow('"a b" is not a usable install target.')
  })

  it('appends -y and the targets for an unattended run', () => {
    expect(
      buildAgentFeatureSkillInstallCommand(['orca-cli'], {
        sourceCommit,
        yes: true,
        agents: ['universal']
      })
    ).toBe(
      `npx skills@${SKILLS_CLI_VERSION} add ${source} --skill orca-cli --global --agent universal -y`
    )
  })
})
