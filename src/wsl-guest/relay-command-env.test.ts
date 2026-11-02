import { describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
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

  it('falls back to homedir() for user bins when the relay env carries no HOME', () => {
    const env = buildRelayCommandEnv({ PATH: '/usr/bin' }, 'linux')

    expect(env.PATH?.split(':')).toContain('/home/fallback/.local/bin')
    expect(env.PATH).not.toContain('undefined')
  })

  it('adds only POSIX fallbacks when no home directory can be resolved', () => {
    vi.mocked(homedir).mockReturnValueOnce('')
    const env = buildRelayCommandEnv({ PATH: '' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toEqual(expect.arrayContaining(['/usr/local/bin', '/usr/bin', '/bin']))
    expect(segments.some((s) => s.includes('.local/bin'))).toBe(false)
  })

  it('keeps inherited PATH entries ahead of the appended fallbacks', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '/custom/bin' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments.indexOf('/custom/bin')).toBeLessThan(segments.indexOf('/usr/bin'))
  })

  it('orders the static POSIX fallbacks ahead of the resolved user bins', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments.indexOf('/usr/bin')).toBeLessThan(segments.indexOf('/home/me/.local/bin'))
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
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.interactive')
    expect(env.GIT_CONFIG_VALUE_0).toBe('false')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.guiPrompt')
    expect(env.GIT_CONFIG_VALUE_1).toBe('false')
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
    expect(env.LC_ALL).toBe('en_US.UTF-8')
    expect(env.PATH?.split(':')).toEqual(expect.arrayContaining(['/custom/bin', '/usr/bin']))
  })
})
