import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn(), toastError: vi.fn() }))
vi.mock('@/lib/bot-host-page', () => ({ openBotHostPageOrSay: mocks.open }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { isSlackAuthorizeUrl, openSlackApprovalHere, openSlackAppsHere } from './slack-page-here'

afterEach(() => {
  mocks.open.mockReset()
  mocks.toastError.mockReset()
})

describe('slack-page-here', () => {
  it('accepts only Slack’s own https approval page', () => {
    expect(isSlackAuthorizeUrl('https://slack.com/oauth/v2/authorize?client_id=1&state=s')).toBe(
      true
    )
    for (const url of [
      'http://slack.com/oauth/v2/authorize?state=s',
      'https://slack.com.example.test/oauth/v2/authorize',
      'https://evil.test/?https://slack.com/oauth/v2/authorize',
      'https://user@slack.com/oauth/v2/authorize',
      'https://slack.com:8443/oauth/v2/authorize',
      'https://slack.com/oauth/v2/authorize/../../apps',
      'https://api.slack.com/apps',
      'file:///etc/passwd',
      'not a url'
    ]) {
      expect(isSlackAuthorizeUrl(url), url).toBe(false)
    }
  })

  it("opens an approval page in this computer's browser, with no bot", () => {
    mocks.open.mockReturnValue('system-browser')
    const url = 'https://slack.com/oauth/v2/authorize?state=s'
    expect(openSlackApprovalHere(url)).toBe('system-browser')
    expect(mocks.open).toHaveBeenCalledWith('local', url, { local: 'system' })
  })

  it('refuses any other link from a host, and says so', () => {
    expect(openSlackApprovalHere('https://evil.test/oauth/v2/authorize')).toBe('unrouted')
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it("opens Slack's token page in this computer's browser", () => {
    mocks.open.mockReturnValue('system-browser')
    openSlackAppsHere()
    expect(mocks.open).toHaveBeenCalledWith('local', 'https://api.slack.com/apps', {
      local: 'system'
    })
  })
})
