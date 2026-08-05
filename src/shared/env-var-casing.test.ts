import { describe, expect, it } from 'vitest'
import { readEnvVar } from './env-var-casing'

describe('env var casing', () => {
  it('reads a variable regardless of the key casing the host used', () => {
    expect(readEnvVar({ PATH: '/usr/bin' }, 'PATH')).toBe('/usr/bin')
    // Why: native Windows processes expose `Path`, so env.PATH is undefined there.
    expect(readEnvVar({ Path: 'C:\\Windows' }, 'PATH')).toBe('C:\\Windows')
    expect(readEnvVar({ path: 'C:\\Windows' }, 'PATH')).toBe('C:\\Windows')
    expect(readEnvVar({}, 'PATH')).toBeUndefined()
  })

  it('prefers an exact match over a differently cased one', () => {
    expect(readEnvVar({ Path: 'wrong', PATH: 'right' }, 'PATH')).toBe('right')
  })

  it('ignores unrelated keys that merely share a prefix', () => {
    expect(readEnvVar({ PATHEXT: '.EXE' }, 'PATH')).toBeUndefined()
  })
})
