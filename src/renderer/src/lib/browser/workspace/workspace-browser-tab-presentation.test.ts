import { describe, expect, it } from 'vitest'
import {
  openFailure,
  openFailureDetail,
  remoteOpenFailure
} from './workspace-browser-tab-presentation'

describe('openFailureDetail', () => {
  it("names the host's failure without the URL its error carried", () => {
    const hostError = new Error('Could not open https://github.com/org/private/pull/1', {
      cause: Object.assign(new Error('Browser profile work was not found'), {
        code: 'invalid_argument'
      })
    })
    const detail = openFailureDetail(
      openFailure('Unable to open URL.', 'remote browser open failed', hostError, {
        kind: 'host-error',
        stage: 'create',
        code: 'invalid_argument'
      })
    )
    expect(detail).toContain('create')
    expect(detail).toContain('invalid_argument')
    expect(detail).not.toContain('github.com')
  })

  it('shows an unrecognized host code as unknown', () => {
    const detail = openFailureDetail(
      openFailure('Unable to open URL.', 'remote browser open failed', undefined, {
        kind: 'host-error',
        stage: 'create',
        code: 'other_code'
      })
    )
    expect(detail).toContain('unknown')
    expect(detail).not.toContain('other_code')
  })

  it("keeps a first failure's missing code instead of borrowing the cleanup error's", () => {
    const cleanupFailure = Object.assign(new Error('gone'), { code: 'browser_tab_not_found' })
    const detail = openFailureDetail(
      remoteOpenFailure('Unable to open URL.', { stage: 'materialize', code: null }, cleanupFailure)
    )
    expect(detail).toContain('materialize')
    expect(detail).not.toContain('browser_tab_not_found')
  })

  it('adds nothing for errors that did not come from a browser open', () => {
    expect(openFailureDetail(new Error('Unable to open URL.'))).toBeNull()
  })
})
