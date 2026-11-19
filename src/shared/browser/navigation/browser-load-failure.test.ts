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
  it('tells the person to add a blocked site, but not to add an ftp page', () => {
    expect(siteListText('https://blocked.test/').description).toContain('add it in Settings')
    expect(siteListText('ftp://blocked.test/').description).toContain("ftp: pages can't open")
  })
})
