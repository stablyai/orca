import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveRemoteOperationErrorMessage } from './source-control-remote-error'

// Why: an exec rejection whose stderr was empty reaches the renderer with an empty `message`.
// Built by assignment because `new Error('')` is the very thing the lint rule forbids writing.
function withMessage(message: string): Error {
  const error = new Error('replaced below')
  error.message = message
  return error
}

describe('source-control remote error formatting', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('a toast that says nothing is worse than a generic one', () => {
    // Why: the producer elides the middle of an oversized blob with this marker. It is Orca's own
    // bookkeeping, so a toast reading "[…]" tells the user only that something was cut.
    const ELIDED = `${'remote: policy note\n'.repeat(3)}[\u2026]\nfatal: Could not read from remote repository.`

    it('never shows the truncation marker as the reason', () => {
      expect(resolveRemoteOperationErrorMessage(new Error(ELIDED), { isPush: true })).toBe(
        'Push failed. Could not read from remote repository. Check your remote access and try again.'
      )
      expect(resolveRemoteOperationErrorMessage(new Error(ELIDED), undefined)).toBe(
        'Could not read from remote repository.'
      )
    })

    it.each([
      [undefined, 'Remote operation failed'],
      [{ isFetch: true }, 'Fetch failed. Check your connection and try again.'],
      [{ isFastForward: true }, 'Fast-forward failed. Check your connection and try again.'],
      [{ isRebase: true }, 'Rebase failed. Check your connection and try again.']
    ] as const)('falls back to words when there is no detail at all (%#)', (options, expected) => {
      // Absent must not become empty: an error carrying nothing, and Electron's wrapper around one.
      expect(resolveRemoteOperationErrorMessage(withMessage(''), options)).toBe(expected)
      expect(
        resolveRemoteOperationErrorMessage(
          new Error("Error invoking remote method 'git:fetch': Error: "),
          options
        )
      ).toBe(expected)
    })

    it('does not let a bare remote: line blank out a toast that had something to say', () => {
      // An empty `remote:` payload used to latch as the detail, so the readable line below it
      // never reached the user.
      const toast = resolveRemoteOperationErrorMessage(
        new Error('remote: \nConnection closed by 140.82.114.4 port 22'),
        { isFetch: true }
      )

      expect(toast).toContain('Connection closed by 140.82.114.4 port 22')
      expect(toast).not.toBe('Fetch failed. ')
    })
  })

  it.each([
    [{ isFetch: true }, 'Fetch failed. Connection closed by 140.82.114.4 port 22'],
    [{ isFastForward: true }, 'Fast-forward failed. Connection closed by 140.82.114.4 port 22'],
    [{ isRebase: true }, 'Rebase failed. Connection closed by 140.82.114.4 port 22']
  ] as const)(
    'keeps Electron\u2019s IPC wrapper out of the no-line-stood-out fallback (%#)',
    (options, expected) => {
      const error = new Error(
        "Error invoking remote method 'git:fetch': Error: Connection closed by 140.82.114.4 port 22"
      )

      expect(resolveRemoteOperationErrorMessage(error, options)).toBe(expected)
    }
  )

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
      'Push failed. error: GH006 protected branch update failed. Check your remote access and try again.'
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
