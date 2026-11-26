import { describe, expect, it } from 'vitest'
import {
  SITE_LIST_BLOCKED_ERROR_NAME,
  describeBrowserLoadFailure,
  formatBrowserLoadFailureText
} from './browser-load-failure'

function siteListText(validatedUrl: string): { title: string; description: string | null } {
  const loadError = {
    code: -20,
    description: SITE_LIST_BLOCKED_ERROR_NAME,
    validatedUrl
  }
  return formatBrowserLoadFailureText(loadError, describeBrowserLoadFailure(loadError, null))
}

describe('site list load failure copy', () => {
  it('tells the person to add a blocked site, but not to add an ftp or file page', () => {
    expect(siteListText('https://blocked.test/').description).toContain('add it in Settings')
    for (const url of ['ftp://blocked.test/', 'file:///tmp/a.html']) {
      expect(siteListText(url).description).toContain("pages can't open")
    }
  })
})
