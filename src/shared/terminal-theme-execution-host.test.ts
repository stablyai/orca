import { describe, expect, it } from 'vitest'
import {
  getConnectionTerminalThemeHostId,
  getRepoTerminalThemeHostId,
  normalizeTerminalThemeHostId
} from './terminal-theme-execution-host'

describe('terminal theme host keys', () => {
  it('maps a project row and its PTY connection to the same key', () => {
    expect(getRepoTerminalThemeHostId({ connectionId: null })).toBe('local')
    expect(getConnectionTerminalThemeHostId(null)).toBe('local')
    expect(getRepoTerminalThemeHostId({ connectionId: 'user@box:22' })).toBe(
      getConnectionTerminalThemeHostId('user@box:22')
    )
    expect(getRepoTerminalThemeHostId({ executionHostId: 'ssh:user%40box%3A22' })).toBe(
      getConnectionTerminalThemeHostId('user@box:22')
    )
  })

  it('re-encodes a non-canonical stored ssh spelling so it still meets its PTYs', () => {
    expect(getRepoTerminalThemeHostId({ executionHostId: 'ssh:user@box' })).toBe('ssh:user%40box')
    expect(getConnectionTerminalThemeHostId('ssh:user@box')).toBe('ssh:user%40box')
    expect(normalizeTerminalThemeHostId('ssh:user@box')).toBe('ssh:user%40box')
  })

  it('excludes paired-runtime rows and unparsable wire keys', () => {
    expect(getRepoTerminalThemeHostId({ executionHostId: 'runtime:env-1' })).toBeNull()
    expect(normalizeTerminalThemeHostId('runtime:env-1')).toBeNull()
    expect(normalizeTerminalThemeHostId('ssh:')).toBeNull()
    expect(normalizeTerminalThemeHostId(42)).toBeNull()
  })
})
