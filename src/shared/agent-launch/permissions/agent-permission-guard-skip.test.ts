import { describe, expect, it } from 'vitest'
import {
  agentSupportsPermissionGuardSkip,
  normalizeAgentPermissionGuardSkip
} from './agent-permission-guard-skip'
import { applyAgentPermissionMode } from './tui-agent-permissions'
import { agentLaunchSettingsMutationUpdates } from '../choices/agent-launch-settings'
import { agentEnvironmentMutationUpdates } from '../choices/agent-launch-environment-updates'
import { wholeAgentEnvironmentUpdates } from '../choices/agent-launch-permission-updates'
import { composeAgentLaunchProfile } from '../choices/agent-launch-legacy-publication'
import { resolveTuiAgentLaunchEnv } from '../choices/tui-agent-launch-defaults'
import { resolveAgentStartupPlanInputs } from '../startup/agent-startup-plan-inputs'
import { AgentLaunchSettingsMutation } from '../../rpc-contract/agent-launch-settings-params'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'

const GUARD_ENV = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS'

const settingsWith = (
  choice: AgentPermissionChoice,
  guardSkip: Record<string, true> = { claude: true }
) => ({
  agentPermissionDefault: choice,
  agentPermissionOverrides: {},
  agentPermissionGuardSkip: guardSkip,
  agentDefaultArgs: {},
  agentDefaultEnv: {}
})

describe('agentSupportsPermissionGuardSkip', () => {
  it('covers the Claude Code launch modes and nothing else', () => {
    expect(agentSupportsPermissionGuardSkip('claude')).toBe(true)
    expect(agentSupportsPermissionGuardSkip('claude-agent-teams')).toBe(true)
    for (const agent of ['codex', 'gemini', 'goose', 'openclaude', 'qoder']) {
      expect(agentSupportsPermissionGuardSkip(agent)).toBe(false)
    }
  })
})

describe('normalizeAgentPermissionGuardSkip', () => {
  it('keeps only an explicit true on a Claude Code launch mode', () => {
    expect(
      normalizeAgentPermissionGuardSkip({
        claude: true,
        'claude-agent-teams': true,
        codex: true,
        gemini: false,
        nonsense: true
      })
    ).toEqual({ claude: true, 'claude-agent-teams': true })
  })

  it.each([undefined, null, 'yes', 42, { claude: 'yes' }, { claude: 1 }] as const)(
    'reads %s as nobody opted in',
    (value) => {
      expect(normalizeAgentPermissionGuardSkip(value)).toEqual({})
    }
  )
})

describe('resolveTuiAgentLaunchEnv', () => {
  it('adds the variable for an opted-in Claude-family agent on Full access', () => {
    for (const agent of ['claude', 'claude-agent-teams'] as const) {
      expect(
        resolveTuiAgentLaunchEnv(agent, settingsWith('full-access', { [agent]: true }), 'darwin')
      ).toEqual({ [GUARD_ENV]: '1' })
    }
  })

  // The CLI reads it only in the mode --dangerously-skip-permissions puts it in.
  it.each(['own', 'ask', 'accept-edits', 'auto'] as const)('adds nothing under %s', (choice) => {
    expect(resolveTuiAgentLaunchEnv('claude', settingsWith(choice), 'darwin')).toEqual({})
  })

  it('adds nothing without the opt-in', () => {
    expect(resolveTuiAgentLaunchEnv('claude', settingsWith('full-access', {}), 'darwin')).toEqual(
      {}
    )
  })

  it('adds nothing for another vendor on Full access', () => {
    expect(
      resolveTuiAgentLaunchEnv('codex', settingsWith('full-access', { codex: true }), 'darwin')
    ).toEqual({})
  })

  it('leaves the user their own value for the same name', () => {
    expect(
      resolveTuiAgentLaunchEnv(
        'claude',
        { ...settingsWith('full-access'), agentDefaultEnv: { claude: { [GUARD_ENV]: '0' } } },
        'darwin'
      )
    ).toEqual({ [GUARD_ENV]: '0' })
  })
})

describe('launch surfaces', () => {
  it('reaches a terminal launch', () => {
    expect(
      resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: settingsWith('full-access'),
        platform: 'darwin',
        isRemote: false,
        shell: 'posix'
      }).agentEnv
    ).toEqual({ [GUARD_ENV]: '1' })
  })

  // Older clients have no control for the opt-in, so the profile they launch from must not carry it.
  it('stays out of the profile published for older clients', () => {
    const published = composeAgentLaunchProfile(
      { ...settingsWith('full-access'), agentDefaultEnv: { claude: { KEEP: 'mine' } } },
      'darwin'
    )
    expect(published.agentDefaultEnv.claude).toEqual({ KEEP: 'mine' })
  })
})

describe('permission-guard-skip mutation', () => {
  it('stores and withdraws the opt-in', () => {
    const settings = settingsWith('full-access', {})
    const enabled = agentLaunchSettingsMutationUpdates(
      settings,
      { type: 'permission-guard-skip', agent: 'claude', enabled: true },
      'darwin'
    )
    expect(enabled).toEqual({ agentPermissionGuardSkip: { claude: true } })
    expect(
      agentLaunchSettingsMutationUpdates(
        { ...settings, ...enabled },
        { type: 'permission-guard-skip', agent: 'claude', enabled: false },
        'darwin'
      )
    ).toEqual({ agentPermissionGuardSkip: {} })
  })

  it('refuses an agent with no built-in refusals of its own', () => {
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        settingsWith('full-access', {}),
        { type: 'permission-guard-skip', agent: 'codex', enabled: true },
        'darwin'
      )
    ).toThrow()
  })

  // A paired client reaches the host through this schema, so an unlisted type never arrives.
  it('is accepted by the launch-settings RPC contract', () => {
    expect(
      AgentLaunchSettingsMutation.safeParse({
        type: 'permission-guard-skip',
        agent: 'claude',
        enabled: true
      }).success
    ).toBe(true)
    expect(
      AgentLaunchSettingsMutation.safeParse({ type: 'permission-guard-skip', agent: 'claude' })
        .success
    ).toBe(false)
  })
})

describe('settings writes', () => {
  // Stored as the user's own entry it would outlive the opt-in that produced it.
  it('does not store the variable when an Environment edit lands', () => {
    const settings = settingsWith('full-access')
    expect(
      agentEnvironmentMutationUpdates(
        settings,
        { type: 'environment-set', agent: 'claude', name: 'KEEP', value: 'mine' },
        'darwin'
      ).agentDefaultEnv?.claude
    ).toEqual({ KEEP: 'mine' })
    // The Environment field never shows Orca's entry, so an edit from it never names it.
    expect(
      wholeAgentEnvironmentUpdates(settings, 'claude', { KEEP: 'mine' }, 'darwin').agentDefaultEnv
        ?.claude
    ).toEqual({ KEEP: 'mine' })
  })

  it('writes nothing when an Environment edit changed nothing', () => {
    expect(
      wholeAgentEnvironmentUpdates(settingsWith('full-access'), 'claude', {}, 'darwin')
    ).toEqual({})
  })

  // Adding claude to the env-driven presets would both enable this for everyone on Full access and
  // let bulk permission changes erase the entries users added by hand.
  it('leaves hand-added Claude environment alone on a bulk permission change', () => {
    const before = { claude: { ANTHROPIC_BASE_URL: 'https://claude.example.test' } }
    for (const mode of ['manual', 'yolo', 'auto'] as const) {
      expect(
        applyAgentPermissionMode({ mode, agent: 'claude', agentDefaultEnv: before }).agentDefaultEnv
      ).toEqual(before)
    }
  })
})
