import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatSubmodulePushFailureDetail,
  isDivergentPullReconciliationError,
  isNoUpstreamError,
  normalizeGitErrorMessage,
  pullArgsSpecifyReconciliation,
  runPullWithDivergenceFallback,
  stripCredentialsFromMessage
} from './git-remote-error'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stripCredentialsFromMessage', () => {
  it.each([
    ['https://user:secret@host/repo', 'https://host/repo'],
    ['custom+git.1://user:sec:ret@host/repo', 'custom+git.1://host/repo'],
    ['SSH://git:secret@host/repo', 'SSH://host/repo'],
    ['HTTPS://token@host/repo', 'HTTPS://host/repo'],
    ['http://token@host/repo', 'http://host/repo'],
    ['ssh://git@host/repo', 'ssh://git@host/repo'],
    ['git@host:repo', 'git@host:repo'],
    ['123://user:secret@host', '123://user:secret@host'],
    ['123git+1://user:secret@host', '123git+1://host'],
    ['https://user:secret/path@host', 'https://user:secret/path@host'],
    ['https://user:secret\u00a0tail@host', 'https://user:secret\u00a0tail@host'],
    ['https://user:secret@token@host', 'https://host'],
    ['https://user:pa@ss:word@host/repo', 'https://host/repo'],
    ['ssh://user:pa@ss:word@host/repo', 'ssh://host/repo'],
    ['https://user:pa@ss:word@host?query=@other', 'https://host?query=@other'],
    ['https://user:pa@ss:word@host#fragment=@other', 'https://host#fragment=@other'],
    ['https://user:pa@ss:word@host/path@other', 'https://host/path@other'],
    ['https://user:secret?query=@host', 'https://user:secret?query=@host'],
    ['https://user:secret#fragment=@host', 'https://user:secret#fragment=@host'],
    [
      '界 https://user:secret@host/😀 ssh://git@host https://token@other',
      '界 https://host/😀 ssh://git@host https://other'
    ]
  ])('preserves URL structure when redacting %s', (input, expected) => {
    expect(stripCredentialsFromMessage(input)).toBe(expected)
  })
})

describe('normalizeGitErrorMessage', () => {
  it('bounds redaction time when ANSI stripping joins a long scheme-like word', () => {
    const error = new Error(
      `remote: ${'\x1b[31ma\x1b[0m'.repeat(65_536)}\nfatal: denied https://user:secret@host/repo`
    )
    const start = performance.now()

    expect(normalizeGitErrorMessage(error, 'push')).toBe('fatal: denied https://host/repo')
    expect(performance.now() - start).toBeLessThan(2_000)
  })

  it.each([
    ' ! [rejected] main -> main (stale info)',
    '\t!\t[rejected] main -> main (stale info)\t',
    ' \x1b[31m! [rejected] main -> main (stale info)\x1b[m',
    '\x1b[31m ! [rejected] main -> main (stale info)\x1b[0m'
  ])('preserves stale lease rejection details: %s', (rejection) => {
    for (const newline of ['\n', '\r\n']) {
      const output = [
        'Command failed: git push https://user:secret@example.com/repo.git',
        rejection,
        "error: failed to push some refs to 'https://token@example.com/repo.git'"
      ].join(newline)

      expect(normalizeGitErrorMessage(new Error(output), 'push')).toBe(
        output
          .replace('user:secret@', '')
          .replace('token@', '')
          .replaceAll('\x1b[31m', '')
          .replaceAll('\x1b[m', '')
          .replaceAll('\x1b[0m', '')
      )
    }
  })

  it.each([
    'https://user:sec\x1b[1 qret@example.com/repo.git',
    'https://sec\x1b]8;;https://example.org\x07ret\x1b]8;;\x07@example.com/repo.git'
  ])('redacts ANSI-bearing URL userinfo in stale lease diagnostics: %s', (url) => {
    const error = new Error(
      [
        `Command failed: git push ${url}`,
        ' ! [rejected] main -> main (stale\x1b[31m info\x1b[m)',
        "error: failed to push some refs to 'origin'"
      ].join('\n')
    )

    expect(normalizeGitErrorMessage(error, 'push')).toBe(
      [
        'Command failed: git push https://example.com/repo.git',
        ' ! [rejected] main -> main (stale info)',
        "error: failed to push some refs to 'origin'"
      ].join('\n')
    )
  })

  it('does not classify a rejection marker on a separate line as a stale lease rejection', () => {
    const tail = "error: failed to push some refs to 'origin'"
    const error = new Error(`Command failed: git push\n !\n [rejected] main (stale info)\n${tail}`)

    expect(normalizeGitErrorMessage(error, 'push')).toBe(tail)
  })

  it('handles push errors containing many blank lines', () => {
    const tail = "error: failed to push some refs to 'origin'"
    const error = new Error(`Command failed: git push\n${'\n'.repeat(64_000)}${tail}`)

    expect(normalizeGitErrorMessage(error, 'push')).toBe(tail)
  })

  it.each(['remote: stale info', 'hook: stale info'])(
    'does not classify unrelated output as a lease rejection: %s',
    (output) => {
      const tail = "error: failed to push some refs to 'origin'"
      const error = new Error(`Command failed: git push\n${output}\n${tail}`)

      expect(normalizeGitErrorMessage(error, 'push')).toBe(tail)
    }
  )

  it.each(['push', 'pull', 'fetch', 'upstream'] as const)(
    'classifies noninteractive credential refusal for %s',
    (operation) => {
      for (const stderr of [
        'fatal: unable to get password from user',
        "fatal: could not read Password for 'https://user@example.com': terminal prompts disabled"
      ]) {
        expect(normalizeGitErrorMessage(new Error(stderr), operation)).toBe(
          'Authentication failed. Check your remote credentials.'
        )
      }
    }
  )

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

  it('preserves redacted pre-push hook output instead of the generic git tail line', () => {
    const error = new Error(
      [
        'Command failed: git push https://x-access-token:ghp_secret@github.com/acme/repo.git HEAD',
        'husky - pre-push hook failed',
        'eslint found 2 errors',
        "error: failed to push some refs to 'https://ghp_tailSecret@github.com/acme/repo.git'"
      ].join('\n')
    )

    const message = normalizeGitErrorMessage(error, 'push')

    expect(message).toContain('husky - pre-push hook failed')
    expect(message).toContain('eslint found 2 errors')
    expect(message).toContain(
      "error: failed to push some refs to 'https://github.com/acme/repo.git'"
    )
    expect(message).not.toContain('x-access-token')
    expect(message).not.toContain('ghp_secret')
    expect(message).not.toContain('ghp_tailSecret')
  })

  it('does not preserve remote pre-receive output as a push hook failure', () => {
    const error = new Error(
      [
        'Command failed: git push origin main',
        'remote: pre-receive hook declined',
        'remote: eslint failed in hosted checks',
        "error: failed to push some refs to 'origin'"
      ].join('\n')
    )

    expect(normalizeGitErrorMessage(error, 'push')).toBe(
      "error: failed to push some refs to 'origin'"
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
  it.each([
    "Unable to push sub\x1b[1 qmodule 'https://user:sec\x1b[1 qret@example.com/repo.git'\n(fetch\x1b[1 q first)",
    "Submodule 'https://user:sec\x1b[1 qret@example.com/repo.git' has remote changes. Pull inside the submodule, then try again."
  ])('sanitizes raw and normalized submodule details before classification: %s', (message) => {
    expect(formatSubmodulePushFailureDetail(message)).toBe(
      "Submodule 'https://example.com/repo.git' has remote changes. Pull inside the submodule, then try again."
    )
  })

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

describe('isDivergentPullReconciliationError', () => {
  it('detects git 2.27+ divergent-branch reconciliation failures', () => {
    const error = new Error(
      'Command failed: git pull\n' +
        'hint: You have divergent branches and need to specify how to reconcile them.\n' +
        'fatal: Need to specify how to reconcile divergent branches.'
    )

    expect(isDivergentPullReconciliationError(error)).toBe(true)
  })

  it('does not match a fast-forward-only abort on divergent branches', () => {
    const error = new Error(
      'Command failed: git pull\nfatal: Not possible to fast-forward, aborting.'
    )

    expect(isDivergentPullReconciliationError(error)).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isDivergentPullReconciliationError('divergent branches')).toBe(false)
  })
})

describe('pullArgsSpecifyReconciliation', () => {
  it('is false when no strategy flag is present', () => {
    expect(pullArgsSpecifyReconciliation([])).toBe(false)
    expect(pullArgsSpecifyReconciliation(['origin', 'main'])).toBe(false)
  })

  it('is true for any explicit reconciliation flag', () => {
    expect(pullArgsSpecifyReconciliation(['--ff-only'])).toBe(true)
    expect(pullArgsSpecifyReconciliation(['--rebase'])).toBe(true)
    expect(pullArgsSpecifyReconciliation(['--no-rebase'])).toBe(true)
    expect(pullArgsSpecifyReconciliation(['--rebase=interactive'])).toBe(true)
    expect(pullArgsSpecifyReconciliation(['-r'])).toBe(true)
  })
})

describe('runPullWithDivergenceFallback', () => {
  const divergentError = new Error(
    'Command failed: git pull\n' +
      'hint: You have divergent branches and need to specify how to reconcile them.\n' +
      'fatal: Need to specify how to reconcile divergent branches.'
  )

  it('retries with merge reconciliation args on a policy error', async () => {
    const calls: string[][] = []
    const runPull = vi.fn(async (effectiveArgs: string[]) => {
      calls.push(effectiveArgs)
      if (effectiveArgs.length === 0) {
        throw divergentError
      }
    })

    await runPullWithDivergenceFallback([], runPull)

    expect(calls).toEqual([[], ['--no-rebase']])
    expect(runPull).toHaveBeenCalledTimes(2)
  })

  it('does not retry when pull args already specify reconciliation', async () => {
    const runPull = vi.fn(async () => {
      throw divergentError
    })

    await expect(runPullWithDivergenceFallback(['--ff-only'], runPull)).rejects.toBe(divergentError)
    expect(runPull).toHaveBeenCalledTimes(1)
    expect(runPull).toHaveBeenCalledWith(['--ff-only'])
  })

  it('rethrows non-divergence errors without retrying', async () => {
    const otherError = new Error('fatal: Not possible to fast-forward, aborting.')
    const runPull = vi.fn(async () => {
      throw otherError
    })

    await expect(runPullWithDivergenceFallback([], runPull)).rejects.toBe(otherError)
    expect(runPull).toHaveBeenCalledTimes(1)
  })
})
