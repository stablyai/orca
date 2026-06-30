import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyRefreshBaseRefError,
  formatRefreshBaseRefError,
  parseRefreshBaseRefErrorPrefix,
  throwRefreshBaseRefError
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

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['plain object', { message: 'Could not resolve host github.com' }],
    ['number', 42],
    ['empty Error', new Error('placeholder')]
  ])('returns "unknown" for non-Error input: %s', (_label, input) => {
    expect(classifyRefreshBaseRefError(input).code).toBe('unknown')
  })

  it('classifies HTTPS "Authentication failed" without publickey as "auth"', () => {
    const error = new Error(
      "fatal: Authentication failed for 'https://user@github.com/foo/bar.git/'"
    )
    expect(classifyRefreshBaseRefError(error).code).toBe('auth')
  })

  it('first-match precedence: network wins over auth when stderr contains both', () => {
    const error = new Error(
      'fatal: Could not resolve host github.com\nPermission denied (publickey).'
    )
    expect(classifyRefreshBaseRefError(error).code).toBe('network')
  })

  it('scopes classification to the first fatal: line so help-text mentions do not flip the code', () => {
    // Why: git's help output can include phrases like "no upstream" in trailing
    // lines; the actual failure (auth) is on the first fatal: line. Without
    // fatal-line scoping, the helper would classify as noUpstream.
    const error = new Error(
      'fatal: Authentication failed for https://user@github.com/foo/bar\n' +
        'hint: use `git remote set-head origin --auto` if no upstream tracking info exists'
    )
    expect(classifyRefreshBaseRefError(error).code).toBe('auth')
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

  it('round-trips an empty message body', () => {
    const formatted = formatRefreshBaseRefError({ code: 'network', message: '' })
    expect(parseRefreshBaseRefErrorPrefix(formatted)).toEqual({ code: 'network', message: '' })
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

describe('throwRefreshBaseRefError', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    consoleSpy?.mockRestore()
  })

  it.each(['refresh-base-ref', 'refresh-base-ref-precheck', 'refresh-base-ref-runtime'] as const)(
    'logs the expected tag and throws a formatted [code] error (%s)',
    (tag) => {
      consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(() =>
        throwRefreshBaseRefError({
          tag,
          baseBranch: 'main',
          remote: 'origin',
          cause: new Error('fatal: Could not resolve host github.com')
        })
      ).toThrow(/^\[network\] Could not refresh base ref "main" from "origin"\.$/)
      expect(consoleSpy).toHaveBeenCalledWith(
        `[${tag}]`,
        expect.objectContaining({ message: 'fatal: Could not resolve host github.com' })
      )
    }
  )

  it('classifies a non-Error cause to "unknown" and still emits the formatted prefix', () => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      throwRefreshBaseRefError({
        tag: 'refresh-base-ref',
        baseBranch: 'main',
        remote: 'origin',
        cause: 'plain string'
      })
    ).toThrow(/^\[unknown\] Could not refresh base ref "main" from "origin"\.$/)
  })

  it.each([
    ['double quotes', 'feat"with"quotes', 'origin'],
    ['backslash', 'feat\\with\\backslashes', 'origin'],
    ['unicode', 'ветка', 'происхождение']
  ])('safely interpolates baseBranch/remote containing %s', (_label, baseBranch, remote) => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let caught: unknown
    try {
      throwRefreshBaseRefError({
        tag: 'refresh-base-ref',
        baseBranch,
        remote,
        cause: new Error('something weird')
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain(`"${baseBranch}"`)
    expect(message).toContain(`"${remote}"`)
    expect(parseRefreshBaseRefErrorPrefix(message)).not.toBeNull()
  })

  it('documents that newlines in baseBranch/remote break downstream parsing', () => {
    // Why: the parser uses /^\[(\w+)\]\s*(.*)$/ which by default does not match
    // \n. Newline-bearing values would produce a message that parseRefreshBaseRefErrorPrefix
    // rejects. The throw site does not currently scrub them. Callers must
    // validate branch names upstream if they want renderer dispatch to work.
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let caught: unknown
    try {
      throwRefreshBaseRefError({
        tag: 'refresh-base-ref',
        baseBranch: 'feat\nwith\nnewlines',
        remote: 'origin',
        cause: new Error('something weird')
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(parseRefreshBaseRefErrorPrefix((caught as Error).message)).toBeNull()
  })

  it('scrubs credentials from the cause before logging to console.error', () => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      throwRefreshBaseRefError({
        tag: 'refresh-base-ref',
        baseBranch: 'main',
        remote: 'origin',
        cause: new Error(
          "fatal: unable to access 'https://user:secret@github.com/foo/private': The requested URL returned error: 403"
        )
      })
    } catch {
      // expected
    }
    const loggedArg = consoleSpy.mock.calls[0]?.[1]
    expect(loggedArg).toBeInstanceOf(Error)
    expect((loggedArg as Error).message).not.toContain('secret')
  })
})
