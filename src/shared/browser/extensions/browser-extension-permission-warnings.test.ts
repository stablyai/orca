import { describe, expect, it } from 'vitest'
import { newBrowserExtensionWarnings } from './browser-extension-permission-warnings'

/** Bitwarden 2026.10's access, as the install store recorded it. */
const BITWARDEN = {
  permissions: ['activeTab', 'alarms', 'clipboardRead', 'storage', 'tabs', 'webNavigation'],
  hostPermissions: ['https://*/*', 'http://*/*']
}

describe('newBrowserExtensionWarnings', () => {
  it('holds a permission whose warning is new, listing only that one', () => {
    const update = { ...BITWARDEN, permissions: [...BITWARDEN.permissions, 'alarms', 'history'] }
    expect(newBrowserExtensionWarnings(update, BITWARDEN)).toEqual({
      permissions: ['history'],
      hostPermissions: []
    })
  })

  it('holds new host access unless every site was already granted', () => {
    const granted = { permissions: [], hostPermissions: ['https://*.example.com/*'] }
    expect(
      newBrowserExtensionWarnings(
        { permissions: [], hostPermissions: ['https://example.com/*', 'https://bank.example/*'] },
        granted
      ).hostPermissions
    ).toEqual(['https://bank.example/*'])
    expect(
      newBrowserExtensionWarnings({ permissions: [], hostPermissions: ['<all_urls>'] }, granted)
        .hostPermissions
    ).toEqual(['<all_urls>'])
    expect(
      newBrowserExtensionWarnings(
        { permissions: [], hostPermissions: ['https://bank.example/*'] },
        BITWARDEN
      ).hostPermissions
    ).toEqual([])
  })
})
