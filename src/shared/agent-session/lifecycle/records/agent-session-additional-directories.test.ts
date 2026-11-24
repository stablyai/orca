import { describe, expect, it } from 'vitest'
import {
  extractAdditionalDirectoriesFromArgs,
  isAgentSessionAdditionalDirectories,
  resolveAdditionalDirectoriesFromLaunch
} from './agent-session-additional-directories'

describe('agent-session-additional-directories', () => {
  it('preserves Windows backslash paths under powershell tokenization', () => {
    expect(
      extractAdditionalDirectoriesFromArgs(
        '--model gemini --add-dir C:\\Users\\PC\\repo -add-dir=D:\\shared',
        'powershell'
      )
    ).toEqual(['C:\\Users\\PC\\repo', 'D:\\shared'])
  })

  it('stops extracting after -- and deduplicates across sources', () => {
    expect(
      extractAdditionalDirectoriesFromArgs(
        '--add-dir "/tmp/a b" -- --add-dir /tmp/ignored',
        'posix'
      )
    ).toEqual(['/tmp/a b'])

    expect(
      resolveAdditionalDirectoriesFromLaunch(
        ['/repo/one', '/repo/two'],
        '--add-dir /repo/two --add-dir /repo/three',
        'posix'
      )
    ).toEqual(['/repo/one', '/repo/two', '/repo/three'])
  })

  it('validates persisted additionalDirectories bounds and rejects NUL bytes', () => {
    expect(isAgentSessionAdditionalDirectories(['/repo/a', '/repo/b'])).toBe(true)
    expect(isAgentSessionAdditionalDirectories([''])).toBe(false)
    expect(isAgentSessionAdditionalDirectories(['/repo/a\0b'])).toBe(false)
    expect(isAgentSessionAdditionalDirectories(Array(65).fill('/repo'))).toBe(false)
    expect(isAgentSessionAdditionalDirectories(['x'.repeat(4097)])).toBe(false)
  })
})
