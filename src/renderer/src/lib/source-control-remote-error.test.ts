import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveRemoteOperationErrorMessage } from './source-control-remote-error'

describe('source-control remote error formatting', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefers fatal detail over an earlier remote detail for publish failures', () => {
    const error = new Error('remote: protected branch\r\nfatal: Authentication failed\r\n')

    expect(resolveRemoteOperationErrorMessage(error, { publish: true })).toBe(
      'Publish Branch failed. Authentication failed. Check your remote access and try again.'
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

  it('maps force-push, publish, and sync push-stage hook failures to blocked copy', () => {
    const error = new Error(
      "git push failed: Command failed: git push origin main\nerror: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1"
    )

    expect(resolveRemoteOperationErrorMessage(error, { isForcePush: true })).toBe(
      'Force Push blocked — pre-push hook failed.'
    )
    expect(resolveRemoteOperationErrorMessage(error, { publish: true })).toBe(
      'Publish Branch blocked — pre-push hook failed.'
    )
    expect(resolveRemoteOperationErrorMessage(error, { isSync: true, isSyncPushStage: true })).toBe(
      'Sync blocked — pre-push hook failed.'
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

  it('extracts publish details from newline-heavy output without full line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const progress = 'remote: Enumerating objects\r\n'.repeat(10_000)
    const error = new Error(
      `${progress}fatal: unable to access https://token:secret@example.com/repo.git\r\n`
    )

    const result = resolveRemoteOperationErrorMessage(error, { publish: true })

    expect(result).toContain('Publish Branch failed. unable to access https://example.com/repo.git')
    const usedLineSplit = splitSpy.mock.calls.some(([separator]) => {
      if (typeof separator === 'string') {
        return separator === '\n'
      }
      return separator instanceof RegExp && separator.source === '\\r?\\n'
    })
    const usedCrlfReplace = replaceSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r\\n'
    )
    expect(usedLineSplit).toBe(false)
    expect(usedCrlfReplace).toBe(false)
  })
})
