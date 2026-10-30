import { describe, expect, it, vi } from 'vitest'
import { resolveBrowserWebviewLoadFailure } from './browser-webview-load-failure'

describe('resolveBrowserWebviewLoadFailure', () => {
  it('swallows aborted races and subframe failures for every backend', () => {
    expect(
      resolveBrowserWebviewLoadFailure({
        errorCode: -3,
        errorDescription: 'ERR_ABORTED',
        validatedURL: 'https://replaced.internal/',
        isMainFrame: true
      })
    ).toBeNull()
    expect(
      resolveBrowserWebviewLoadFailure({
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://tracker.internal/pixel',
        isMainFrame: false
      })
    ).toBeNull()
  })

  it('never reads a lazy fallback URL for an event it discards', () => {
    const fallbackUrl = vi.fn(() => 'https://example.com/current')
    expect(resolveBrowserWebviewLoadFailure({ errorCode: -3 }, { fallbackUrl })).toBeNull()
    expect(fallbackUrl).not.toHaveBeenCalled()
    expect(
      resolveBrowserWebviewLoadFailure(
        { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: '' },
        { fallbackUrl }
      )
    ).toMatchObject({ validatedUrl: 'https://example.com/current' })
  })
})
