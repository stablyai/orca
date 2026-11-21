import { describe, expect, it } from 'vitest'
import { addWslEnvKeys } from './wsl-env'

describe('addWslEnvKeys', () => {
  it('keeps one entry when the same name is registered with different flags', () => {
    const env: Record<string, string | undefined> = {
      WSLENV: 'foo/p:FOO/w:other/u:OTHER/p'
    }
    addWslEnvKeys(env, ['FOO/u'])
    const tokens = (env.WSLENV ?? '').split(':').filter(Boolean)
    expect(tokens.filter((token) => token.toUpperCase().startsWith('FOO/'))).toEqual(['FOO/u'])
    expect(tokens).not.toContain('foo/p')
    expect(tokens).not.toContain('FOO/w')
    expect(tokens.filter((token) => token === 'other/u' || token === 'OTHER/p')).toEqual([
      'other/u',
      'OTHER/p'
    ])
  })
})
