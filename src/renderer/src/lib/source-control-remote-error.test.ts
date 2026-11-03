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
