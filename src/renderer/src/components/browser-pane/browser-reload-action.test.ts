import { describe, expect, it } from 'vitest'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from './browser-page-guest-recovery'
import {
  resolveBrowserReloadButtonLabelKind,
  resolveBrowserReloadIntent
} from './browser-reload-action'

const idle = { loading: false, loadErrorCode: null }
const loading = { loading: true, loadErrorCode: null }
const failed = { loading: false, loadErrorCode: -105 }
const guestFailed = { loading: false, loadErrorCode: BROWSER_GUEST_RECOVERY_ERROR_CODE }

describe('resolveBrowserReloadIntent', () => {
  it('reloads an idle page from every trigger', () => {
    expect(resolveBrowserReloadIntent('button', idle)).toBe('reload')
    expect(resolveBrowserReloadIntent('reload', idle)).toBe('reload')
    expect(resolveBrowserReloadIntent('hard-reload', idle)).toBe('hard-reload')
  })

  it('stops an in-flight load only from the toolbar button', () => {
    expect(resolveBrowserReloadIntent('button', loading)).toBe('stop')
    expect(resolveBrowserReloadIntent('reload', loading)).toBe('reload')
    expect(resolveBrowserReloadIntent('hard-reload', loading)).toBe('hard-reload')
  })

  // Why: reload() on chrome-error:// only refreshes the error page — every entry point must retry the load.
  it('routes a failed load to the retry path from the menu too', () => {
    expect(resolveBrowserReloadIntent('button', failed)).toBe('retry-load')
    expect(resolveBrowserReloadIntent('reload', failed)).toBe('retry-load')
    expect(resolveBrowserReloadIntent('hard-reload', failed)).toBe('retry-load')
  })

  it('routes a guest-recovery failure to guest recovery from the menu too', () => {
    expect(resolveBrowserReloadIntent('button', guestFailed)).toBe('retry-guest-recovery')
    expect(resolveBrowserReloadIntent('reload', guestFailed)).toBe('retry-guest-recovery')
    expect(resolveBrowserReloadIntent('hard-reload', guestFailed)).toBe('retry-guest-recovery')
  })

  it('prefers stop over retry when a failed page is already reloading', () => {
    expect(resolveBrowserReloadIntent('button', { loading: true, loadErrorCode: -105 })).toBe(
      'stop'
    )
  })
})

describe('resolveBrowserReloadButtonLabelKind', () => {
  it('names the button for what it actually does', () => {
    expect(resolveBrowserReloadButtonLabelKind(idle)).toBe('reload')
    expect(resolveBrowserReloadButtonLabelKind(loading)).toBe('stop')
    expect(resolveBrowserReloadButtonLabelKind(failed)).toBe('retry')
    expect(resolveBrowserReloadButtonLabelKind(guestFailed)).toBe('retry')
  })
})
