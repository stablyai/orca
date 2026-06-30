import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyRefreshBaseRefError,
  formatRefreshBaseRefError,
  formatSubmodulePushFailureDetail,
  isNoUpstreamError,
  normalizeGitErrorMessage,
  parseRefreshBaseRefErrorPrefix
} from './git-remote-error'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeGitErrorMessage', () => {
  it('keeps the submodule name when a recursive push is rejected', () => {
    const error = new Error(
      "Command failed: git push\nPushing submodule 'find-cmux-followers'\n" +
        'To https://github.com/stablyai/orca-internal\n' +
        ' ! [rejected]        master -> master (fetch first)\n' +
        "Unable to push submodule 'find-cmux-followers'\n" +
        'fatal: failed to push all needed submodules'
    )

    expect(normalizeGitErrorMessage(error, 'push')).toBe(
      "Submodule 'find-cmux-followers' has remote changes. Pull inside the submodule, then try again."
    )
  })

  it('explains how to configure a pull policy for divergent branches', () => {
    const error = new Error(
      'Command failed: git pull\n' +
        'hint: You have divergent branches and need to specify how to reconcile them.\n' +
        'fatal: Need to specify how to reconcile divergent branches.'
    )

    expect(normalizeGitErrorMessage(error, 'pull')).toBe(
      'Pull needs a Git pull policy for divergent branches. Configure one for this repository ' +
        'or host, then try again: git config pull.rebase false (merge), ' +
        'git config pull.rebase true (rebase), or git config pull.ff only (fast-forward only).'
    )
  })

  it('uses the tail diagnostic from newline-heavy failures without line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const error = new Error(
      `Command failed: git fetch\r\n${'remote: progress update\r\n'.repeat(10_000)}remote side closed connection\r\n`
    )

    expect(normalizeGitErrorMessage(error, 'fetch')).toBe('remote side closed connection')

    const usedLineSplit = splitSpy.mock.calls.some(
      ([separator]) =>
        (typeof separator === 'string' && separator === '\n') ||
        (separator instanceof RegExp && separator.source === '\\r?\\n')
    )
    expect(usedLineSplit).toBe(false)
  })
})

describe('formatSubmodulePushFailureDetail', () => {
  it('keeps normalized guidance when transport layers prefix the error', () => {
    expect(
      formatSubmodulePushFailureDetail(
        "Error invoking remote method 'git:push': Error: Submodule 'vendor/tools' has remote changes. Pull inside the submodule, then try again."
      )
    ).toBe(
      "Submodule 'vendor/tools' has remote changes. Pull inside the submodule, then try again."
    )
  })

  it('falls back to submodule-specific guidance when git omits the nested reason', () => {
    expect(
      formatSubmodulePushFailureDetail(
        "Unable to push submodule 'vendor/tools'\nfatal: failed to push all needed submodules"
      )
    ).toBe(
      "Submodule 'vendor/tools' could not be pushed. Resolve the submodule push error, then try again."
    )
  })

  it('checks newline-heavy output without full CRLF normalization', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const message = `${'remote: progress\r\n'.repeat(10_000)}Unable to push submodule 'vendor/tools'\r\nfatal: failed to push all needed submodules\r\n`

    expect(formatSubmodulePushFailureDetail(message)).toBe(
      "Submodule 'vendor/tools' could not be pushed. Resolve the submodule push error, then try again."
    )

    const usedCrlfReplace = replaceSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r\\n'
    )
    expect(usedCrlfReplace).toBe(false)
  })
})

describe('isNoUpstreamError', () => {
  it('treats a missing HEAD@{u} tracking ref as no upstream', () => {
    const error = new Error(
      "fatal: ambiguous argument 'HEAD@{u}': unknown revision or path not in the working tree.\n" +
        "Use '--' to separate paths from revisions, like this:\n" +
        "'git <command> [<revision>...] -- [<file>...]'"
    )

    expect(isNoUpstreamError(error)).toBe(true)
  })

  it('does not treat unrelated ambiguous refs as no upstream', () => {
    const error = new Error(
      "fatal: ambiguous argument 'feature': unknown revision or path not in the working tree."
    )

    expect(isNoUpstreamError(error)).toBe(false)
  })
})

describe('classifyRefreshBaseRefError', () => {
  it('classifies DNS / network failures as "network"', () => {
    const error = new Error('Command failed: git fetch\nfatal: Could not resolve host github.com')
    expect(classifyRefreshBaseRefError(error)).toEqual({
      code: 'network',
      message: 'Network error. Check your connection.',
      cause: error
    })
  })

  it('classifies SSH publickey failures as "auth"', () => {
    const error = new Error(
      'Command failed: git fetch\ngit@github.com: Permission denied (publickey).'
    )
    expect(classifyRefreshBaseRefError(error)).toEqual({
      code: 'auth',
      message: 'git@github.com: Permission denied (publickey).',
      cause: error
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
