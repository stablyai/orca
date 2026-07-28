import { describe, expect, it } from 'vitest'
import { readEnvVar, resolveEnvVarKey } from './env-var-casing'

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

  it('resolves the key the host already uses so writes overwrite instead of colliding', () => {
    expect(resolveEnvVarKey({ Path: 'C:\\Windows' }, 'PATH')).toBe('Path')
    expect(resolveEnvVarKey({ PATH: '/usr/bin' }, 'PATH')).toBe('PATH')
    // Why: absent means the caller picks the canonical name.
    expect(resolveEnvVarKey({}, 'PATH')).toBe('PATH')
  })

  it('ignores unrelated keys that merely share a prefix', () => {
    expect(readEnvVar({ PATHEXT: '.EXE' }, 'PATH')).toBeUndefined()
    expect(resolveEnvVarKey({ PATHEXT: '.EXE' }, 'PATH')).toBe('PATH')
  })
})
