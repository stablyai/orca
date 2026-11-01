import { afterEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import {
  isNonFastForwardRemoteError,
  resolveRemoteOperationErrorMessage
} from './source-control-remote-error'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('source-control remote error formatting', () => {
  it('recognizes split colored stale lease markers from remote hosts', () => {
    const error = new Error(
      " ! [rejected] main -> main (stale\x1b[31m info\x1b[m)\nerror: failed to push some refs to 'origin'"
    )

    expect(resolveRemoteOperationErrorMessage(error, { isForcePush: true })).toBe(
      'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
    )
    expect(isNonFastForwardRemoteError(error)).toBe(true)
  })

  it('prefers fatal detail over an earlier remote detail for publish failures', () => {
    const error = new Error('remote: protected branch\r\nfatal: Authentication failed\r\n')

    expect(resolveRemoteOperationErrorMessage(error, { publish: true })).toBe(
      'Publish Branch failed. Authentication failed. Check your remote access and try again.'
    )
  })

  it.each(['fatal', 'remote'])(
    'redacts ANSI-bearing credentials in %s details from older remote hosts',
    (prefix) => {
      const error = new Error(
        `git.push failed:\n${prefix}: Access denied to https://user:sec\x1b[1 qret@example.com/repo.git`
      )

      expect(resolveRemoteOperationErrorMessage(error, { isPush: true })).toBe(
        'Push failed. Access denied to https://example.com/repo.git. Check your remote access and try again.'
      )
    }
  )

  it.each([
    [{ isFetch: true }, 'Fetch failed. '],
    [{ isFastForward: true }, 'Fast-forward failed. '],
    [{ isRebase: true }, 'Rebase failed. '],
    [{}, '']
  ])('redacts ANSI-bearing credentials in fallback details for %j', (options, prefix) => {
    const error = new Error('Access denied to https://user:sec\x1b[1 qret@example.com/repo.git')

    expect(resolveRemoteOperationErrorMessage(error, options)).toBe(
      `${prefix}Access denied to https://example.com/repo.git`
    )
    expect(error.message).toContain('user:sec\x1b[1 qret@')
  })

  it.each([
    [{ publish: true }, 'Publish Branch'],
    [{ isSync: true }, 'Sync'],
    [{ isForcePush: true }, 'Force Push'],
    [{ isPush: true }, 'Push']
  ])('sanitizes and classifies older-host submodule errors for %j', (options, operation) => {
    const error = new Error(
      "Unable to push sub\x1b[1 qmodule 'https://user:sec\x1b[1 qret@example.com/repo.git'\n" +
        ' ! [rejected] main -> main (fetch\x1b[1 q first)'
    )

    expect(resolveRemoteOperationErrorMessage(error, options)).toBe(
      `${operation} failed. Submodule 'https://example.com/repo.git' has remote changes. Pull inside the submodule, then try again.`
    )
    expect(isNonFastForwardRemoteError(error)).toBe(true)
    expect(
      resolveRemoteOperationErrorMessage(
        new Error("Unable to push submodule 'https://user:sec\x1b[1 qret@example.com/repo.git'"),
        options
      )
    ).toBe(
      `${operation} failed. Submodule 'https://example.com/repo.git' could not be pushed. Resolve the submodule push error, then try again.`
    )
  })

  it('maps pre-push hook failures to a hook-specific message instead of remote access guidance', () => {
    const error = new Error(
      "git push failed: Command failed: git push origin main\nerror: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1\neslint found 2 errors"
    )

    expect(resolveRemoteOperationErrorMessage(error, { isPush: true })).toBe(
      'Push blocked — lint failed during push.'
    )
  })

  it('does not classify sync non-push-stage hook-looking output as push blocked', () => {
    const error = new Error(
      'sync fetch failed before push\nremote: pre-push hook docs mention lint\neslint output'
    )

    const message = resolveRemoteOperationErrorMessage(error, { isSync: true })
    expect(message).toBe(
      'Sync failed. pre-push hook docs mention lint. Check your remote access and try again.'
    )
    expect(message).not.toContain('blocked')
  })

  it('keeps auth, protected-branch, pre-receive, non-fast-forward, and submodule push guidance out of blocked copy', () => {
    const protectedError = new Error(
      'git push failed: Command failed: git push origin main\nremote: error: GH006 protected branch update failed.\nremote: lint status is required'
    )
    const preReceiveError = new Error(
      'git push failed: Command failed: git push origin main\nremote: pre-receive hook declined\nremote: eslint failed'
    )
    const authError = new Error(
      'git push failed: Command failed: git push origin main\nremote: Repository not found.\nfatal: Authentication failed'
    )
    const nffError = new Error('updates were rejected because the remote contains work')
    const submoduleError = new Error(
      "Command failed: git push\nUnable to push submodule 'deps/lib'\nfatal: failed to push all needed submodules"
    )

    expect(resolveRemoteOperationErrorMessage(protectedError, { isPush: true })).toBe(
      'Push failed. error: GH006 protected branch update failed.. Check your remote access and try again.'
    )
    expect(resolveRemoteOperationErrorMessage(preReceiveError, { isPush: true })).toBe(
      'Push failed. pre-receive hook declined. Check your remote access and try again.'
    )
    expect(resolveRemoteOperationErrorMessage(authError, { isPush: true })).toBe(
      'Push failed. Authentication failed. Check your remote access and try again.'
    )
    expect(resolveRemoteOperationErrorMessage(nffError, { isPush: true })).toBe(
      'Push rejected — remote has changes. Pull first, then try again.'
    )
    expect(resolveRemoteOperationErrorMessage(submoduleError, { isPush: true })).toBe(
      "Push failed. Submodule 'deps/lib' could not be pushed. Resolve the submodule push error, then try again."
    )
  })
  it('translates classified sentences and passes unclassified errors through verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const submoduleError = new Error(
      "Command failed: git push\nUnable to push submodule 'deps/lib'\nfatal: failed to push all needed submodules"
    )

    expect(resolveRemoteOperationErrorMessage(submoduleError, { isPush: true })).toBe(
      es.sourceControl.remoteError.failedWithDetail.push.replace(
        '{{detail}}',
        es.sourceControl.remoteError.submodule.namedPushFailed.replace('{{name}}', 'deps/lib')
      )
    )
    expect(resolveRemoteOperationErrorMessage(new Error('some new git failure'))).toBe(
      'some new git failure'
    )
  })
})
