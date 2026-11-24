import { describe, expect, it } from 'vitest'
import { openFailure, openFailureDetail } from './workspace-browser-tab-presentation'

describe('openFailureDetail', () => {
  it("names the host's failure without the URL its error carried", () => {
    const hostError = new Error('Could not open https://github.com/org/private/pull/1', {
      cause: Object.assign(new Error('Browser profile work was not found'), {
        code: 'invalid_argument'
      })
    })
    const detail = openFailureDetail(
      openFailure(
        'Unable to open URL.',
        'runtime browser tab creation failed (invalid_argument)',
        hostError
      )
    )
    expect(detail).toContain('runtime browser tab creation failed (invalid_argument)')
    expect(detail).not.toContain('github.com')
  })

  it('adds nothing for errors that did not come from a browser open', () => {
    expect(openFailureDetail(new Error('Unable to open URL.'))).toBeNull()
  })
})
