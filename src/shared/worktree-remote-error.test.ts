import { describe, expect, it } from 'vitest'
import {
  classifyRefreshBaseRefError,
  formatRefreshBaseRefError,
  parseRefreshBaseRefErrorPrefix
} from './worktree-remote-error'

describe('classifyRefreshBaseRefError', () => {
  it('classifies DNS / network failures as "network"', () => {
    const error = new Error('Command failed: git fetch\nfatal: Could not resolve host github.com')
    expect(classifyRefreshBaseRefError(error)).toEqual({
      code: 'network',
      message: 'Network error. Check your connection.'
    })
  })

  it('classifies SSH publickey failures as "auth"', () => {
    const error = new Error(
      'Command failed: git fetch\ngit@github.com: Permission denied (publickey).'
    )
    expect(classifyRefreshBaseRefError(error)).toEqual({
      code: 'auth',
      message: 'git@github.com: Permission denied (publickey).'
    })
  })

  it('classifies 401/403/404 from a remote URL as "remoteForbidden"', () => {
    const error = new Error(
      "fatal: unable to access 'https://github.com/foo/private': The requested URL returned error: 403"
    )
    expect(classifyRefreshBaseRefError(error).code).toBe('remoteForbidden')
  })

  it('classifies no-upstream stderr as "noUpstream"', () => {
    const error = new Error('Command failed: git fetch\nfatal: no upstream configured for branch')
    expect(classifyRefreshBaseRefError(error).code).toBe('noUpstream')
  })

  it('classifies missing remote ref as "remoteRefMissing"', () => {
    const error = new Error(
      "Command failed: git fetch\nfatal: couldn't find remote ref 'refs/heads/main'"
    )
    expect(classifyRefreshBaseRefError(error).code).toBe('remoteRefMissing')
  })

  it('classifies repository-not-found as "remoteForbidden"', () => {
    const error = new Error(
      "Command failed: git fetch\nfatal: repository 'https://example.com/private.git/' not found"
    )
    expect(classifyRefreshBaseRefError(error).code).toBe('remoteForbidden')
  })

  it('falls back to "unknown" with tail-line message when no pattern matches', () => {
    const error = new Error('Command failed: git fetch\nsomething weird happened')
    const result = classifyRefreshBaseRefError(error)
    expect(result.code).toBe('unknown')
    expect(result.message).toBe('something weird happened')
  })

  it('returns "unknown" for non-Error input', () => {
    const result = classifyRefreshBaseRefError('plain string')
    expect(result).toEqual({ code: 'unknown', message: 'Git remote operation failed.' })
  })

  it('scrubs credentials before classifying 403 forbidden', () => {
    const error = new Error(
      "fatal: unable to access 'https://user:secret@github.com/foo/private': The requested URL returned error: 403"
    )
    const result = classifyRefreshBaseRefError(error)
    expect(result.code).toBe('remoteForbidden')
    expect(result.message).not.toContain('secret')
  })
})

describe('formatRefreshBaseRefError', () => {
  it('encodes code and message into a [code] prefix', () => {
    expect(formatRefreshBaseRefError({ code: 'network', message: 'Network error.' })).toBe(
      '[network] Network error.'
    )
  })
})

describe('parseRefreshBaseRefErrorPrefix', () => {
  it('round-trips with formatRefreshBaseRefError', () => {
    const formatted = formatRefreshBaseRefError({
      code: 'remoteRefMissing',
      message: 'branch missing'
    })
    expect(parseRefreshBaseRefErrorPrefix(formatted)).toEqual({
      code: 'remoteRefMissing',
      message: 'branch missing'
    })
  })

  it('returns null when the prefix is missing', () => {
    expect(parseRefreshBaseRefErrorPrefix('legacy unprefixed message')).toBeNull()
  })

  it('returns null on an unknown code', () => {
    expect(parseRefreshBaseRefErrorPrefix('[bogus] something')).toBeNull()
  })
})

describe('formatRefreshBaseRefError / parseRefreshBaseRefErrorPrefix round-trip', () => {
  it.each([
    'network',
    'auth',
    'noUpstream',
    'remoteRefMissing',
    'remoteForbidden',
    'unknown'
  ] as const)('round-trips %s', (code) => {
    const message = `sample ${code} message`
    const formatted = formatRefreshBaseRefError({ code, message })
    expect(parseRefreshBaseRefErrorPrefix(formatted)).toEqual({ code, message })
  })
})

describe('parseRefreshBaseRefErrorPrefix edge cases', () => {
  it('parses a prefix with an empty body', () => {
    expect(parseRefreshBaseRefErrorPrefix('[network]')).toEqual({ code: 'network', message: '' })
  })

  it('returns null for an empty prefix `[]`', () => {
    expect(parseRefreshBaseRefErrorPrefix('[] hello')).toBeNull()
  })

  it('returns null for a code with internal whitespace', () => {
    expect(parseRefreshBaseRefErrorPrefix('[ net work ] x')).toBeNull()
  })

  it('returns null when prefix is not at the start', () => {
    expect(parseRefreshBaseRefErrorPrefix('prefix [network] mid-string')).toBeNull()
  })
})
