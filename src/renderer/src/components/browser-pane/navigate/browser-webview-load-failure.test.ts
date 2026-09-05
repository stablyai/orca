import { describe, expect, it, vi } from 'vitest'
import { resolveBrowserWebviewLoadFailure } from './browser-webview-load-failure'

describe('resolveBrowserWebviewLoadFailure', () => {
  it('fills defaults and redacts the validated URL', () => {
    expect(resolveBrowserWebviewLoadFailure({})).toEqual({
      code: -1,
      description: 'Unknown load failure',
      validatedUrl: 'about:blank'
    })
    expect(
      resolveBrowserWebviewLoadFailure({
        errorCode: -102,
        errorDescription: 'ERR_CONNECTION_REFUSED',
        validatedURL: 'https://example.com/app'
      })
    ).toEqual({
      code: -102,
      description: 'ERR_CONNECTION_REFUSED',
      validatedUrl: 'https://example.com/app'
    })
  })

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

  it('names the page from the fallback URL when the event carries none', () => {
    expect(
      resolveBrowserWebviewLoadFailure(
        { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: '' },
        { fallbackUrl: 'https://example.com/current' }
      )
    ).toMatchObject({ validatedUrl: 'https://example.com/current' })
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

  it('keeps a usable description when Chromium reports an empty one', () => {
    expect(
      resolveBrowserWebviewLoadFailure({ errorCode: -105, errorDescription: '' })
    ).toMatchObject({ description: 'Unknown load failure' })
  })
})
