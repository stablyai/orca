import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatSubmodulePushFailureDetail,
  isNoUpstreamError,
  normalizeGitErrorMessage,
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

  it.each(['remote: stale info', 'hook: stale info'])(
    'does not classify unrelated output as a lease rejection: %s',
    (output) => {
      const tail = "error: failed to push some refs to 'origin'"
      const error = new Error(`Command failed: git push\n${output}\n${tail}`)

      expect(normalizeGitErrorMessage(error, 'push')).toBe(tail)
    }
  )

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
})

describe('isNoUpstreamError', () => {
  it('does not treat unrelated ambiguous refs as no upstream', () => {
    const error = new Error(
      "fatal: ambiguous argument 'feature': unknown revision or path not in the working tree."
    )

    expect(isNoUpstreamError(error)).toBe(false)
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
