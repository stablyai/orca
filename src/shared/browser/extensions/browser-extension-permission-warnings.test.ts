import { describe, expect, it } from 'vitest'
import {
  browserExtensionHostWarning,
  hasBrowserExtensionWarnings,
  newBrowserExtensionWarnings
} from './browser-extension-permission-warnings'

/** Bitwarden 2026.10's access, as the install store recorded it. */
const BITWARDEN = {
  permissions: ['activeTab', 'alarms', 'clipboardRead', 'storage', 'tabs', 'webNavigation'],
  hostPermissions: ['https://*/*', 'http://*/*']
}

describe('newBrowserExtensionWarnings', () => {
  it('lets an update add permissions Chrome shows no warning for', () => {
    const update = {
      ...BITWARDEN,
      permissions: [...BITWARDEN.permissions, 'offscreen', 'idle', 'unlimitedStorage']
    }
    expect(hasBrowserExtensionWarnings(newBrowserExtensionWarnings(update, BITWARDEN))).toBe(false)
  })

  it('lets an update drop access or add a permission with a warning it already shows', () => {
    const update = { permissions: ['storage', 'webNavigation'], hostPermissions: ['https://*/*'] }
    expect(hasBrowserExtensionWarnings(newBrowserExtensionWarnings(update, BITWARDEN))).toBe(false)
    expect(
      newBrowserExtensionWarnings(
        { permissions: ['tabs'], hostPermissions: [] },
        { permissions: ['history'], hostPermissions: [] }
      ).permissions
    ).toEqual([])
  })

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

describe('browserExtensionHostWarning', () => {
  it('names hosts once and folds any wildcard host into every site', () => {
    expect(browserExtensionHostWarning([])).toBeNull()
    expect(browserExtensionHostWarning(['https://*.a.com/*', 'http://a.com/*'])).toEqual({
      kind: 'sites',
      hosts: ['a.com']
    })
    expect(browserExtensionHostWarning(['https://a.com/*', '*://*/*'])).toEqual({
      kind: 'allSites'
    })
  })
})
