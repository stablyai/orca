import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { isSlackAuthorizeUrl, openSlackApprovalHere, openSlackAppsHere } from './slack-page-here'

const openUrl = vi.fn<(url: string) => Promise<void>>()

beforeEach(() => {
  openUrl.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { shell: { openUrl } } })
})

afterEach(() => {
  mocks.toastError.mockReset()
  vi.unstubAllGlobals()
})

describe('slack-page-here', () => {
  it('accepts only Slack’s own https approval page, spelled as checked', () => {
    expect(isSlackAuthorizeUrl('https://slack.com/oauth/v2/authorize?client_id=1&state=s')).toBe(
      true
    )
    expect(isSlackAuthorizeUrl('https://slack.com/oauth/v2/authorize')).toBe(true)
    // Hosts are case-insensitive: still Slack's page.
    expect(isSlackAuthorizeUrl('https://SLACK.com/oauth/v2/authorize?state=s')).toBe(true)
    for (const url of [
      'http://slack.com/oauth/v2/authorize?state=s',
      'https://slack.com.example.test/oauth/v2/authorize',
      'https://slack.com.evil.test/oauth/v2/authorize',
      'https://evilslack.com/oauth/v2/authorize',
      'https://slack.com./oauth/v2/authorize',
      'https://slack.com/oauth/v2/authorizex',
      'https://evil.test/?https://slack.com/oauth/v2/authorize',
      'https://user@slack.com/oauth/v2/authorize',
      'https://slack.com:8443/oauth/v2/authorize',
      'https://slack.com/oauth/v2/authorize/../../apps',
      'https://api.slack.com/apps',
      'file:///etc/passwd',
      'not a url',
      // The parser would tidy each of these into Slack's page; the copied text would not be.
      'https://slack.com:443/oauth/v2/authorize',
      'https://@slack.com/oauth/v2/authorize',
      'https://:@slack.com/oauth/v2/authorize',
      'https://slack.com/oauth/v2/../v2/authorize',
      'https://slack.com/oauth/./v2/authorize',
      'https://slack.com//oauth/v2/authorize',
      'HTTPS://slack.com/OAUTH/v2/authorize',
      // Letters whose Unicode lowercase is ASCII: the copied text would not be Slack's host.
      'https://slac\u212A.com/oauth/v2/authorize',
      'https://\u017Flack.com/oauth/v2/authorize'
    ]) {
      expect(isSlackAuthorizeUrl(url), url).toBe(false)
    }
  })

  it("opens an approval page in this computer's browser once it takes it", async () => {
    const url = 'https://slack.com/oauth/v2/authorize?state=s'
    await expect(openSlackApprovalHere(url)).resolves.toBe(true)
    expect(openUrl).toHaveBeenCalledWith(url)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('says so when the browser could not be opened', async () => {
    openUrl.mockRejectedValue(new Error('no default browser'))
    await expect(openSlackApprovalHere('https://slack.com/oauth/v2/authorize')).resolves.toBe(false)
    await expect(openSlackAppsHere()).resolves.toBe(false)
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
  })

  it('refuses any other link from a host, and says so', async () => {
    await expect(openSlackApprovalHere('https://evil.test/oauth/v2/authorize')).resolves.toBe(false)
    expect(openUrl).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it("opens Slack's token page in this computer's browser", async () => {
    await expect(openSlackAppsHere()).resolves.toBe(true)
    expect(openUrl).toHaveBeenCalledWith('https://api.slack.com/apps')
  })
})
