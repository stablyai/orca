import { describe, expect, it } from 'vitest'
import {
  getDefaultAgentLaunchProfileId,
  normalizeAgentLaunchProfiles,
  resolveAgentLaunchProfile,
  resolveAgentLaunchProfileStartupOptions
} from './agent-launch-profiles'

describe('agent launch profiles', () => {
  it('normalizes persisted profiles and keeps built-in agent identity', () => {
    expect(
      normalizeAgentLaunchProfiles([
        {
          id: ' work ',
          agentId: 'codex',
          name: ' Work ',
          commandOverride: ' codex-nightly ',
          args: ' --profile work ',
          env: { ' CODEX_LOG ': 'trace', EMPTY: 3 },
          disabled: true,
          protected: true
        },
        { id: 'bad-agent', agentId: 'custom', name: 'Custom' },
        { id: 'work', agentId: 'codex', name: 'Duplicate' }
      ])
    ).toEqual([
      {
        id: 'work',
        agentId: 'codex',
        name: 'Work',
        commandOverride: 'codex-nightly',
        args: '--profile work',
        env: { CODEX_LOG: 'trace' },
        disabled: true,
        protected: true
      }
    ])
  })

  it('synthesizes the default profile from compatibility settings', () => {
    const result = resolveAgentLaunchProfileStartupOptions({
      agent: 'codex',
      agentCmdOverrides: { codex: 'codex --profile work' },
      agentDefaultArgs: { codex: '--model gpt-5.1' },
      agentDefaultEnv: { codex: { CODEX_LOG: 'info' } }
    })

    expect(result).toMatchObject({
      ok: true,
      agent: 'codex',
      isDefaultProfile: true,
      cmdOverrides: { codex: 'codex --profile work' },
      agentArgs: '--model gpt-5.1',
      agentEnv: { CODEX_LOG: 'info' }
    })
    expect(result.ok && result.profile.id).toBe(getDefaultAgentLaunchProfileId('codex'))
  })

  it('resolves named profiles without changing built-in agent identity', () => {
    const result = resolveAgentLaunchProfileStartupOptions({
      agent: 'claude',
      profileId: 'personal',
      selectionKind: 'explicit',
      profiles: [
        {
          id: 'personal',
          agentId: 'claude',
          name: 'Personal',
          commandOverride: 'claude-beta',
          args: '--model opus',
          env: { CLAUDE_VERBOSE: '1' }
        }
      ]
    })

    expect(result).toEqual({
      ok: true,
      agent: 'claude',
      cmdOverrides: { claude: 'claude-beta' },
      agentArgs: '--model opus',
      agentEnv: { CLAUDE_VERBOSE: '1' },
      profile: {
        id: 'personal',
        agentId: 'claude',
        name: 'Personal',
        commandOverride: 'claude-beta',
        args: '--model opus',
        env: { CLAUDE_VERBOSE: '1' }
      },
      isDefaultProfile: false
    })
  })

  it('lets named profiles inherit compatibility defaults for unspecified fields', () => {
    const result = resolveAgentLaunchProfileStartupOptions({
      agent: 'codex',
      profileId: 'work',
      profiles: [{ id: 'work', agentId: 'codex', name: 'Work', env: { CODEX_LOG: 'debug' } }],
      agentCmdOverrides: { codex: 'codex --profile base' },
      agentDefaultArgs: { codex: '--model gpt-5.1' },
      agentDefaultEnv: { codex: { BASE: '1', CODEX_LOG: 'info' } }
    })

    expect(result).toMatchObject({
      ok: true,
      cmdOverrides: { codex: 'codex --profile base' },
      agentArgs: '--model gpt-5.1',
      agentEnv: { BASE: '1', CODEX_LOG: 'debug' }
    })
  })

  it('sanitizes named profile args with the same per-agent launch defaults rules', () => {
    const result = resolveAgentLaunchProfileStartupOptions({
      agent: 'opencode',
      profileId: 'work',
      profiles: [
        {
          id: 'work',
          agentId: 'opencode',
          name: 'Work',
          args: '--dangerously-skip-permissions --model opencode/gpt-5'
        }
      ]
    })

    expect(result).toMatchObject({
      ok: true,
      agentArgs: '--model opencode/gpt-5'
    })
  })

  it('falls back for stale stored defaults but fails explicit missing selections', () => {
    expect(
      resolveAgentLaunchProfile({
        agent: 'codex',
        profileId: 'missing',
        selectionKind: 'stored-default',
        profiles: []
      })
    ).toMatchObject({ ok: true, isDefaultProfile: true })

    expect(
      resolveAgentLaunchProfile({
        agent: 'codex',
        profileId: 'missing',
        selectionKind: 'explicit',
        profiles: []
      })
    ).toEqual({ ok: false, error: 'Agent launch profile "missing" was not found.' })
  })

  it('fails explicit wrong-agent and disabled profile selections', () => {
    expect(
      resolveAgentLaunchProfile({
        agent: 'codex',
        profileId: 'claude-work',
        selectionKind: 'explicit',
        profiles: [{ id: 'claude-work', agentId: 'claude', name: 'Claude Work' }]
      })
    ).toEqual({
      ok: false,
      error: 'Agent launch profile "claude-work" belongs to claude, not codex.'
    })

    expect(
      resolveAgentLaunchProfile({
        agent: 'codex',
        profileId: 'work',
        selectionKind: 'explicit',
        profiles: [{ id: 'work', agentId: 'codex', name: 'Work', disabled: true }]
      })
    ).toEqual({ ok: false, error: 'Agent launch profile "Work" is disabled.' })
  })

  it('rejects named profile command overrides that are shell recipes', () => {
    expect(
      resolveAgentLaunchProfileStartupOptions({
        agent: 'codex',
        profileId: 'recipe',
        profiles: [
          {
            id: 'recipe',
            agentId: 'codex',
            name: 'Recipe',
            commandOverride: 'codex --profile work'
          }
        ]
      })
    ).toEqual({
      ok: false,
      error: 'Agent launch profile "Recipe" command override must be a single executable path.'
    })
  })

  it('rejects single-token command overrides with shell control characters', () => {
    expect(
      resolveAgentLaunchProfileStartupOptions({
        agent: 'codex',
        profileId: 'recipe',
        profiles: [
          {
            id: 'recipe',
            agentId: 'codex',
            name: 'Recipe',
            commandOverride: 'codex;curl'
          }
        ]
      })
    ).toEqual({
      ok: false,
      error:
        'Agent launch profile "Recipe" command override must not contain shell control characters.'
    })
  })

  it('allows a named profile command override that is a single executable path', () => {
    expect(
      resolveAgentLaunchProfileStartupOptions({
        agent: 'codex',
        profileId: 'path',
        profiles: [
          {
            id: 'path',
            agentId: 'codex',
            name: 'Path',
            commandOverride: '/usr/local/bin/codex'
          }
        ]
      })
    ).toMatchObject({
      ok: true,
      cmdOverrides: { codex: '/usr/local/bin/codex' }
    })

    expect(
      resolveAgentLaunchProfileStartupOptions({
        agent: 'codex',
        profileId: 'windows-path',
        profiles: [
          {
            id: 'windows-path',
            agentId: 'codex',
            name: 'Windows Path',
            commandOverride: String.raw`C:\Users\me\bin\codex.exe`
          }
        ]
      })
    ).toMatchObject({
      ok: true,
      cmdOverrides: { codex: String.raw`C:\Users\me\bin\codex.exe` }
    })
  })

  it('rejects quoted command overrides until startup can invoke executable argv paths', () => {
    expect(
      resolveAgentLaunchProfileStartupOptions({
        agent: 'codex',
        profileId: 'windows-path',
        profiles: [
          {
            id: 'windows-path',
            agentId: 'codex',
            name: 'Windows Path',
            commandOverride: String.raw`"C:\Program Files\Codex\codex.exe"`
          }
        ]
      })
    ).toEqual({
      ok: false,
      error: 'Agent launch profile "Windows Path" command override must not be quoted.'
    })
  })

  it('keeps legacy default command overrides compatible with existing multi-token commands', () => {
    expect(
      resolveAgentLaunchProfileStartupOptions({
        agent: 'codex',
        agentCmdOverrides: { codex: 'codex --profile work' }
      })
    ).toMatchObject({
      ok: true,
      cmdOverrides: { codex: 'codex --profile work' },
      isDefaultProfile: true
    })
  })
})
