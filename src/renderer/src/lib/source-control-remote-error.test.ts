import { describe, expect, it } from 'vitest'

import { resolveRemoteOperationErrorMessage } from './source-control-remote-error'

describe('source-control remote error formatting', () => {
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
})
