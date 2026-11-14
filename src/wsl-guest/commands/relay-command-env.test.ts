import { describe, expect, it, vi } from 'vitest'
import { buildRelayCommandEnv, buildRelayUnattendedGitEnv } from './relay-command-env'

// Fix the fallback home so no-resolvable-home behavior is testable and independent of the user’s machine.
vi.mock('os', () => ({ homedir: vi.fn(() => '/home/fallback') }))

describe('buildRelayCommandEnv', () => {
  it('preserves Windows Path casing and adds Git install locations', () => {
    const env = buildRelayCommandEnv({ Path: 'C:\\Tools' }, 'win32')

    expect(env.PATH).toBeUndefined()
    expect(env.Path?.split(';')).toEqual(
      expect.arrayContaining(['C:\\Tools', 'C:\\Program Files\\Git\\cmd'])
    )
  })

  it('does not leak POSIX user bins into a Windows relay env', () => {
    const env = buildRelayCommandEnv({ Path: 'C:\\Tools', HOME: '/home/me' }, 'win32')

    expect(env.Path).not.toContain('/home/me/.local/bin')
    expect(env.Path).not.toContain('.npm-global')
  })

  it('keeps inherited PATH entries ahead of the appended fallbacks', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '/custom/bin' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments.indexOf('/custom/bin')).toBeLessThan(segments.indexOf('/usr/bin'))
  })
})

describe('buildRelayUnattendedGitEnv', () => {
  it('disables credential UI while preserving relay PATH, locale, and caller askpass', () => {
    const env = buildRelayUnattendedGitEnv(
      {
        HOME: '/home/me',
        PATH: '/custom/bin',
        LC_ALL: 'de_DE.UTF-8',
        GIT_ASKPASS: '/opt/noninteractive-credential-feeder'
      },
      'linux'
    )

    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect(env.GIT_ASKPASS).toBe('/opt/noninteractive-credential-feeder')
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
    expect(env.LC_ALL).toBe('en_US.UTF-8')
    expect(env.PATH?.split(':')).toEqual(expect.arrayContaining(['/custom/bin', '/usr/bin']))
  })
})
