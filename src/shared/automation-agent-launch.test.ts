import { describe, expect, it } from 'vitest'
import { resolveAutomationAgentArgs, resolveAutomationAgentEnv } from './automation-agent-launch'

const NO_DEFAULTS = { agentDefaultArgs: {}, agentDefaultEnv: {} }

describe('resolveAutomationAgentArgs', () => {
  it('uses the global default args when the automation has no override', () => {
    const args = resolveAutomationAgentArgs('claude', null, {
      agentDefaultArgs: { claude: '--global' },
      agentDefaultEnv: {}
    })
    expect(args).toBe('--global')
  })

  it('lets the automation override replace the global default', () => {
    const args = resolveAutomationAgentArgs(
      'claude',
      { launchArgs: '--local' },
      { agentDefaultArgs: { claude: '--global' }, agentDefaultEnv: {} }
    )
    expect(args).toBe('--local')
  })

  it('falls back to the global default when the override is blank', () => {
    const args = resolveAutomationAgentArgs(
      'claude',
      { launchArgs: '   ' },
      { agentDefaultArgs: { claude: '--global' }, agentDefaultEnv: {} }
    )
    expect(args).toBe('--global')
  })

  it('applies the selected model on top of the resolved args', () => {
    const args = resolveAutomationAgentArgs(
      'claude',
      { launchArgs: '--local', model: 'opus' },
      NO_DEFAULTS
    )
    expect(args).toBe('--local --model opus')
  })

  it('strips agent-incompatible flags from a per-automation override', () => {
    const args = resolveAutomationAgentArgs(
      'opencode',
      { launchArgs: '--dangerously-skip-permissions --foo' },
      NO_DEFAULTS
    )
    expect(args).toBe('--foo')
  })
})

describe('resolveAutomationAgentEnv', () => {
  it('merges the automation env over the global default per key', () => {
    const env = resolveAutomationAgentEnv(
      'claude',
      { env: { SHARED: 'local', LOCAL_ONLY: '1' } },
      { agentDefaultArgs: {}, agentDefaultEnv: { claude: { SHARED: 'global', GLOBAL_ONLY: '2' } } }
    )
    expect(env).toEqual({ SHARED: 'local', LOCAL_ONLY: '1', GLOBAL_ONLY: '2' })
  })

  it('returns the global default when the automation has no env override', () => {
    const env = resolveAutomationAgentEnv('claude', null, {
      agentDefaultArgs: {},
      agentDefaultEnv: { claude: { GLOBAL_ONLY: '2' } }
    })
    expect(env).toEqual({ GLOBAL_ONLY: '2' })
  })
})
