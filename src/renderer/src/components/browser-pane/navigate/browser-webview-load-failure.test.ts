import { describe, expect, it } from 'vitest'
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
})
