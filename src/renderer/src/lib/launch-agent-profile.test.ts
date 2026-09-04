import { describe, expect, it } from 'vitest'
import {
  resolveAgentLaunchWithProfileFallback,
  resolveNewTabAgentLaunch
} from './launch-agent-profile'

describe('resolveNewTabAgentLaunch', () => {
  const settings = {
    agentDefaultArgs: { codex: '--full-auto' },
    agentDefaultEnv: { codex: { CODEX_DEFAULT: '1' } },
    agentLaunchProfiles: [{ id: 'codex-work', agent: 'codex' as const, args: '-c model="x"' }]
  }

  it('keeps the plain launch on the agent defaults', () => {
    expect(resolveNewTabAgentLaunch(settings, 'codex', undefined, undefined)).toEqual({
      agentArgs: '--full-auto',
      agentEnv: { CODEX_DEFAULT: '1' }
    })
  })

  it('preserves an explicit args override, including null', () => {
    expect(resolveNewTabAgentLaunch(settings, 'codex', null, undefined)?.agentArgs).toBeNull()
    expect(resolveNewTabAgentLaunch(settings, 'codex', '--x', undefined)?.agentArgs).toBe('--x')
  })

  it('layers a built-in profile and echoes its id', () => {
    const launch = resolveNewTabAgentLaunch(settings, 'codex', undefined, 'codex-secondary-home')
    expect(launch).toEqual({
      agentArgs: '--full-auto',
      agentEnv: {
        CODEX_DEFAULT: '1',
        ORCA_AGENT_LAUNCH_PROFILE: 'codex-secondary-home',
        ORCA_CODEX_HOME_PROFILE: 'codex-secondary-home'
      },
      launchProfileId: 'codex-secondary-home'
    })
  })

  it('appends custom profile args after the defaults', () => {
    expect(resolveNewTabAgentLaunch(settings, 'codex', undefined, 'codex-work')?.agentArgs).toBe(
      '--full-auto -c model="x"'
    )
  })

  it('fails the launch for an unknown or foreign profile', () => {
    expect(resolveNewTabAgentLaunch(settings, 'codex', undefined, 'nope')).toBeNull()
    expect(resolveNewTabAgentLaunch(settings, 'claude', undefined, 'codex-work')).toBeNull()
  })

  it('falls back to the default launch for a stale profile id', () => {
    const launch = resolveAgentLaunchWithProfileFallback(settings, 'codex', 'codex-gone')
    expect(launch.launchProfileId).toBeUndefined()
    expect(launch.agentEnv.ORCA_AGENT_LAUNCH_PROFILE).toBeUndefined()
    expect(
      resolveAgentLaunchWithProfileFallback(settings, 'codex', 'codex-secondary-home')
        .launchProfileId
    ).toBe('codex-secondary-home')
  })
})
