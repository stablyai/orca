import { describe, expect, it } from 'vitest'
import {
  extractExecutableToken,
  hasPathSeparatorToken,
  isSafeExecutableBasename,
  isSafeOverrideExecutableToken
} from './managed-agent-command-token'

describe('managed agent command tokens', () => {
  it('extracts quoted and escaped POSIX executable paths', () => {
    expect(extractExecutableToken('"/opt/Agent Tools/codex" --flag', { platform: 'linux' })).toBe(
      '/opt/Agent Tools/codex'
    )
    expect(extractExecutableToken('/opt/Agent\\ Tools/codex --flag', { platform: 'linux' })).toBe(
      '/opt/Agent Tools/codex'
    )
  })

  it('preserves Windows path separators', () => {
    expect(
      extractExecutableToken('"C:\\Program Files\\Claude\\claude.exe" --flag', {
        platform: 'win32'
      })
    ).toBe('C:\\Program Files\\Claude\\claude.exe')
  })

  it('distinguishes safe basenames from path tokens', () => {
    expect(isSafeExecutableBasename('claude-code_1.2+')).toBe(true)
    expect(isSafeExecutableBasename('../claude')).toBe(false)
    expect(isSafeExecutableBasename('claude;echo')).toBe(false)
    expect(hasPathSeparatorToken('C:\\Tools\\claude.exe')).toBe(true)
    expect(hasPathSeparatorToken('/opt/codex')).toBe(true)
    expect(hasPathSeparatorToken('codex')).toBe(false)
  })

  it('rejects traversal, control characters, and shell syntax in override paths', () => {
    expect(isSafeOverrideExecutableToken('~/bin/codex')).toBe(true)
    expect(isSafeOverrideExecutableToken('C:\\Program Files\\Claude\\claude.exe')).toBe(true)
    expect(isSafeOverrideExecutableToken('../bin/codex')).toBe(false)
    expect(isSafeOverrideExecutableToken('/opt/codex;echo')).toBe(false)
    expect(isSafeOverrideExecutableToken('/opt/codex\0')).toBe(false)
  })
})
