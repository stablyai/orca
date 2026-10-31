import { describe, expect, it } from 'vitest'
import { parseWorkerRoleProfiles, resolveWorkerRoleParams } from './orchestration-worker-roles'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { resolveStartupShell } from './tui-agent-startup-shell'

const profiles = {
  research: { agent: 'claude', model: 'sonnet', effort: 'high' },
  implementation: { agent: 'codex', model: 'gpt-5.5', effort: 'high' },
  review: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'low', fastMode: true }
}

describe('configured worker roles', () => {
  it('resolves a configured provider without changing placement or task identity', () => {
    expect(
      resolveWorkerRoleParams({ role: 'research', task: 'task_1', on: 'linux' }, profiles)
    ).toEqual({ role: 'research', task: 'task_1', on: 'linux', ...profiles.research })
  })

  it('lets explicit options override a role one field at a time', () => {
    expect(
      resolveWorkerRoleParams({ role: 'review', effort: 'medium', fastMode: false }, profiles)
    ).toEqual({ role: 'review', ...profiles.review, effort: 'medium', fastMode: false })
  })

  it('replaces provider-specific defaults when an explicit different agent is chosen', () => {
    expect(
      resolveWorkerRoleParams({ role: 'research', agent: 'codex', model: 'gpt-5.5' }, profiles)
    ).toEqual({ role: 'research', agent: 'codex', model: 'gpt-5.5' })
  })

  it('keeps the role defaults for an explicit matching agent', () => {
    expect(resolveWorkerRoleParams({ role: 'research', agent: 'claude' }, profiles)).toEqual({
      role: 'research',
      ...profiles.research
    })
  })

  it('preserves the existing agent-only launch contract', () => {
    const params = { agent: 'claude', spec: 'Inspect this folder' }
    expect(resolveWorkerRoleParams(params, undefined)).toBe(params)
  })

  it.each(['missing', 'Research', '__proto__'])(
    'refuses an unconfigured or invalid role %s',
    (role) => {
      expect(() => resolveWorkerRoleParams({ role }, profiles)).toThrow(/role/i)
    }
  )

  it('refuses roles when reusing a running terminal', () => {
    expect(() => resolveWorkerRoleParams({ role: 'review', terminal: 'term_1' }, profiles)).toThrow(
      /terminal/
    )
  })

  it.each([
    { review: { agent: '' } },
    { review: { agent: 'claude', fastMode: 'yes' } },
    { review: { agent: 'codex', model: '  model' } },
    { 'bad role': { agent: 'claude' } },
    { review: { agent: 'claude', extraOption: true } }
  ])('rejects malformed settings instead of silently dropping fields', (value) => {
    expect(() => parseWorkerRoleProfiles(value)).toThrow()
  })

  it('retains configured launcher aliases for execution-host resolution', () => {
    expect(parseWorkerRoleProfiles({ review: { agent: 'my-review-agent' } })).toEqual({
      review: { agent: 'my-review-agent' }
    })
  })
})

describe('worker Fast launch options', () => {
  it('uses the original Cursor launch catalog, including an explicit Fast off', () => {
    for (const fastMode of [true, false]) {
      const checked = checkAgentLaunchModelPreferences({
        agent: 'cursor',
        model: 'gpt-5.3-codex',
        effort: 'low',
        fastMode
      })
      expect(checked).not.toHaveProperty('refusal')
      if ('refusal' in checked) {
        throw new Error(checked.refusal.message)
      }
      const launch = resolveAgentSessionOptionLaunch('cursor', checked.preferences, [], false)
      expect(launch.appliedValues).toEqual({ model: 'gpt-5.3-codex', effort: 'low', fastMode })
      expect(launch.args).toEqual(['--model', `gpt-5.3-codex-low${fastMode ? '-fast' : ''}`])
    }
  })

  it('refuses unproven Codex Fast launch support', () => {
    expect(
      checkAgentLaunchModelPreferences({ agent: 'codex', model: 'opus', fastMode: true })
    ).toHaveProperty('refusal.message', expect.stringContaining('Fast'))
  })

  it.each([true, false])('applies catalogued Claude Fast=%s through settings', (fastMode) => {
    const checked = checkAgentLaunchModelPreferences({ agent: 'claude', model: 'opus', fastMode })
    if ('refusal' in checked) {
      throw new Error(checked.refusal.message)
    }
    const launch = resolveAgentSessionOptionLaunch('claude', checked.preferences, [], false)
    expect(launch.appliedValues).toEqual({ model: 'opus', fastMode })
    expect(launch.args).toEqual(['--model', 'opus', '--settings', JSON.stringify({ fastMode })])
  })

  it('requires a model for a Fast option', () => {
    expect(checkAgentLaunchModelPreferences({ agent: 'cursor', fastMode: false })).toHaveProperty(
      'refusal.message',
      expect.stringContaining('--model')
    )
  })
})

describe('role options on original provider commands', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'preserves the configured Claude Code harness on %s',
    (platform) => {
      const selected = resolveWorkerRoleParams({ role: 'research' }, profiles)
      const checked = checkAgentLaunchModelPreferences({
        agent: 'claude',
        model: selected.model,
        effort: selected.effort
      })
      if ('refusal' in checked) {
        throw new Error(checked.refusal.message)
      }
      const inputs = resolveAgentStartupPlanInputs({
        agent: 'claude',
        platform,
        isRemote: false,
        shell: undefined,
        settings: {
          agentCmdOverrides: { claude: 'my-claude-code' },
          agentDefaultArgs: { claude: '--model haiku --effort low --verbose' }
        },
        sessionOptions: checked.preferences
      })
      const launch = resolveAgentLaunchCommand({
        ...inputs,
        shell: resolveStartupShell(platform, inputs.shell)
      })
      expect(launch).toMatchObject({
        ok: true,
        appliedSessionOptions: { model: 'sonnet', effort: 'high' }
      })
      if (!launch.ok) {
        throw new Error(launch.error)
      }
      expect(launch.command).toContain('my-claude-code')
      expect(launch.command).toContain('--verbose')
      expect(launch.command).not.toContain('haiku')
      expect(launch.command).not.toContain('low')
    }
  )
})
