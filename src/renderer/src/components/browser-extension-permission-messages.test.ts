import { describe, expect, it } from 'vitest'
import {
  describeBrowserExtensionAccess,
  describeUnsupportedBrowserExtensionFeatures
} from './browser-extension-permission-messages'

describe('extension permission messages', () => {
  it('does not promise blocking Orca does not do, and says so in one line', () => {
    // uBlock Origin Lite's permissions.
    const permissions = ['activeTab', 'declarativeNetRequest', 'scripting', 'storage']
    expect(describeBrowserExtensionAccess(permissions, ['<all_urls>'])).toEqual([
      'Read and change all your data on all websites'
    ])
    expect(describeUnsupportedBrowserExtensionFeatures(permissions)).toBe(
      'Not available in Orca yet: blocking content.'
    )
  })

  it('names every unsupported feature once and stays silent when there are none', () => {
    expect(
      describeUnsupportedBrowserExtensionFeatures([
        'nativeMessaging',
        'identity',
        'identity.email',
        'declarativeNetRequestWithHostAccess'
      ])
    ).toBe('Not available in Orca yet: extension sign-in, blocking content.')
    expect(describeUnsupportedBrowserExtensionFeatures(['tabs', 'storage'])).toBeNull()
    expect(describeBrowserExtensionAccess(['tabs', 'webNavigation', 'storage'], [])).toEqual([
      'Read your browsing history'
    ])
  })

  it('warns about talking to desktop apps the way Chrome does, now that Orca supports it', () => {
    // Bitwarden's shape: native messaging requested up front.
    expect(describeBrowserExtensionAccess(['storage', 'nativeMessaging'], [])).toEqual([
      'Communicate with cooperating native applications'
    ])
    expect(describeUnsupportedBrowserExtensionFeatures(['nativeMessaging'])).toBeNull()
  })
})
