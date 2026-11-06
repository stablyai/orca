import { describe, expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from '../choices/agent-launch-settings'
import { agentEnvironmentMutationUpdates } from '../choices/agent-launch-environment-updates'
import { wholeAgentEnvironmentUpdates } from '../choices/agent-launch-permission-updates'
import {
  composeAgentLaunchProfile,
  resolveTuiAgentLaunchEnv
} from '../choices/tui-agent-launch-defaults'
import { AgentLaunchSettingsMutation } from '../../rpc-contract/agent-launch-settings-params'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'

const GUARD_ENV = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS'

const settingsWith = (
  choice: AgentPermissionChoice,
  guardSkip: Record<string, true> = { claude: true },
  agentDefaultEnv: Record<string, Record<string, string>> = {}
) => ({
  agentPermissionDefault: choice,
  agentPermissionOverrides: {},
  agentPermissionGuardSkip: guardSkip,
  agentDefaultArgs: {},
  agentDefaultEnv
})

describe('resolveTuiAgentLaunchEnv', () => {
  it.each(['claude', 'claude-agent-teams'] as const)(
    'adds the variable for opted-in %s',
    (agent) => {
      expect(
        resolveTuiAgentLaunchEnv(agent, settingsWith('full-access', { [agent]: true }), 'darwin')
      ).toEqual({ [GUARD_ENV]: '1' })
    }
  )

  it.each([
    ['claude', settingsWith('ask')],
    ['claude', settingsWith('auto')],
    ['claude', settingsWith('full-access', {})],
    ['codex', settingsWith('full-access', { codex: true })]
  ] as const)('adds nothing for %s with %o', (agent, settings) => {
    expect(resolveTuiAgentLaunchEnv(agent, settings, 'darwin')).toEqual({})
  })
})

describe('settings writes and publication', () => {
  // Stored as the user's own entry it would outlive the opt-in that produced it.
  it('keeps Orca’s entry out while keeping a user entry of the same name', () => {
    const mine = settingsWith('full-access', { claude: true }, { claude: { KEEP: 'mine' } })
    expect(composeAgentLaunchProfile(mine, 'darwin').agentDefaultEnv.claude).toEqual({
      KEEP: 'mine'
    })
    expect(wholeAgentEnvironmentUpdates(mine, 'claude', { KEEP: 'mine' }, 'darwin')).toEqual({})
    const handAdded = settingsWith(
      'full-access',
      { claude: true },
      { claude: { [GUARD_ENV]: '0' } }
    )
    expect(
      agentEnvironmentMutationUpdates(
        handAdded,
        { type: 'environment-set', agent: 'claude', name: 'KEEP', value: 'mine' },
        'darwin'
      ).agentDefaultEnv?.claude
    ).toEqual({ [GUARD_ENV]: '0', KEEP: 'mine' })
  })

  it('stores and withdraws the opt-in, for Claude Code only', () => {
    const mutation = { type: 'permission-guard-skip', agent: 'claude', enabled: true } as const
    // A paired client reaches the host through this schema.
    expect(AgentLaunchSettingsMutation.safeParse(mutation).success).toBe(true)
    const enabled = agentLaunchSettingsMutationUpdates(
      settingsWith('full-access', {}),
      mutation,
      'darwin'
    )
    expect(enabled).toEqual({ agentPermissionGuardSkip: { claude: true } })
    expect(
      agentLaunchSettingsMutationUpdates(
        settingsWith('full-access'),
        { ...mutation, enabled: false },
        'darwin'
      )
    ).toEqual({ agentPermissionGuardSkip: {} })
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        settingsWith('full-access', {}),
        { ...mutation, agent: 'codex' },
        'darwin'
      )
    ).toThrow()
  })
})
