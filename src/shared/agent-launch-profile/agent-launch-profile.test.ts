import { describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_PROFILE_ENV,
  BUILT_IN_AGENT_LAUNCH_PROFILES,
  CLAUDE_SECONDARY_HOME_PROFILE_ID,
  CODEX_SECONDARY_HOME_PROFILE_ID,
  agentLaunchProfileHomeMarkerEnv,
  agentLaunchProfileIdFromEnv,
  agentLaunchProfilesForAgent,
  applyAgentLaunchProfile,
  findAgentLaunchProfile,
  hasAgentLaunchProfileHomeMarker,
  isAgentLaunchProfileId,
  normalizeAgentLaunchProfileSettings,
  resolveAgentLaunchProfiles
} from './agent-launch-profile'

describe('agent launch profiles', () => {
  it('ships one secondary-home profile per credential-home agent', () => {
    expect(BUILT_IN_AGENT_LAUNCH_PROFILES.map((profile) => profile.id)).toEqual([
      CODEX_SECONDARY_HOME_PROFILE_ID,
      CLAUDE_SECONDARY_HOME_PROFILE_ID
    ])
    for (const profile of BUILT_IN_AGENT_LAUNCH_PROFILES) {
      expect(profile.source).toBe('built-in')
      expect(profile.home).toBeDefined()
      expect(profile.args).toBeUndefined()
    }
  })

  it('derives the marker from the home env var so a new family needs no constant', () => {
    expect(agentLaunchProfileHomeMarkerEnv('CODEX_HOME')).toBe('ORCA_CODEX_HOME_PROFILE')
    expect(agentLaunchProfileHomeMarkerEnv('CLAUDE_CONFIG_DIR')).toBe(
      'ORCA_CLAUDE_CONFIG_DIR_PROFILE'
    )
  })

  it('accepts slug ids only', () => {
    expect(isAgentLaunchProfileId('codex-provider-work')).toBe(true)
    expect(isAgentLaunchProfileId('Codex')).toBe(false)
    expect(isAgentLaunchProfileId('-leading')).toBe(false)
    expect(isAgentLaunchProfileId('a'.repeat(65))).toBe(false)
    expect(isAgentLaunchProfileId('')).toBe(false)
  })

  it('normalizes custom rows and refuses to shadow built-ins or duplicate ids', () => {
    const rows = normalizeAgentLaunchProfileSettings([
      { id: 'codex-secondary-home', agent: 'codex', label: 'shadow' },
      { id: 'codex-work', agent: 'codex', label: '  Work  ', args: ' -c model="gpt-5" ' },
      { id: 'codex-work', agent: 'codex', label: 'duplicate' },
      { id: 'claude-proxy', agent: 'claude', env: { ANTHROPIC_BASE_URL: 'https://p', ' ': 'x' } },
      { id: 'bad id', agent: 'codex' },
      { id: 'unknown-agent', agent: 'nope' },
      null,
      'string'
    ])
    expect(rows).toEqual([
      { id: 'codex-work', agent: 'codex', label: 'Work', args: '-c model="gpt-5"' },
      { id: 'claude-proxy', agent: 'claude', env: { ANTHROPIC_BASE_URL: 'https://p' } }
    ])
  })

  it('resolves built-ins first, then custom rows with the id as fallback label', () => {
    const profiles = resolveAgentLaunchProfiles([{ id: 'codex-work', agent: 'codex' }])
    expect(profiles.map((profile) => profile.id)).toEqual([
      CODEX_SECONDARY_HOME_PROFILE_ID,
      CLAUDE_SECONDARY_HOME_PROFILE_ID,
      'codex-work'
    ])
    expect(profiles[2]).toMatchObject({ label: 'codex-work', source: 'custom' })
    expect(agentLaunchProfilesForAgent(profiles, 'codex').map((profile) => profile.id)).toEqual([
      CODEX_SECONDARY_HOME_PROFILE_ID,
      'codex-work'
    ])
  })

  it('rejects a profile that belongs to another agent', () => {
    const profiles = resolveAgentLaunchProfiles([])
    expect(findAgentLaunchProfile(profiles, 'claude', CODEX_SECONDARY_HOME_PROFILE_ID)).toBeNull()
    expect(findAgentLaunchProfile(profiles, 'codex', CODEX_SECONDARY_HOME_PROFILE_ID)?.id).toBe(
      CODEX_SECONDARY_HOME_PROFILE_ID
    )
    expect(findAgentLaunchProfile(profiles, 'codex', undefined)).toBeNull()
  })

  it('layers args after configured args and stamps the profile and home marker into env', () => {
    const profiles = resolveAgentLaunchProfiles([
      { id: 'codex-work', agent: 'codex', args: '-c model_provider="work"', env: { WORK_KEY: '1' } }
    ])
    const secondary = applyAgentLaunchProfile({
      profile: findAgentLaunchProfile(profiles, 'codex', CODEX_SECONDARY_HOME_PROFILE_ID),
      agentArgs: '--full-auto',
      agentEnv: { EXISTING: 'yes' }
    })
    expect(secondary.agentArgs).toBe('--full-auto')
    expect(secondary.agentEnv).toEqual({
      EXISTING: 'yes',
      [AGENT_LAUNCH_PROFILE_ENV]: CODEX_SECONDARY_HOME_PROFILE_ID,
      ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID
    })
    const custom = applyAgentLaunchProfile({
      profile: findAgentLaunchProfile(profiles, 'codex', 'codex-work'),
      agentArgs: '--full-auto',
      agentEnv: { WORK_KEY: 'default' }
    })
    expect(custom.agentArgs).toBe('--full-auto -c model_provider="work"')
    expect(custom.agentEnv).toEqual({ WORK_KEY: '1', [AGENT_LAUNCH_PROFILE_ENV]: 'codex-work' })
    expect(hasAgentLaunchProfileHomeMarker(custom.agentEnv, 'CODEX_HOME')).toBe(false)
    expect(hasAgentLaunchProfileHomeMarker(secondary.agentEnv, 'CODEX_HOME')).toBe(true)
    expect(agentLaunchProfileIdFromEnv(custom.agentEnv)).toBe('codex-work')
    expect(agentLaunchProfileIdFromEnv({})).toBeNull()
  })

  it('leaves a plain launch byte-identical', () => {
    const agentEnv = { A: '1' }
    const result = applyAgentLaunchProfile({ profile: null, agentArgs: '--x', agentEnv })
    expect(result.agentArgs).toBe('--x')
    expect(result.agentEnv).toBe(agentEnv)
  })
})
