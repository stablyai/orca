import { beforeEach, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { i18n } from '@/i18n/i18n'
import { getBrowserPaneSearchEntries, getTerminalLinkActionSearchKeywords } from './browser-search'
import {
  getBrowserLinkRoutingDescription,
  getBrowserLinkRoutingShortcutLabel,
  getLinkRoutingModifierDescription,
  getLinkRoutingModifierTitle
} from './browser-link-routing-copy'

function lookupEnglishCatalog(key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      en
    )
  return typeof value === 'string' ? value : undefined
}

describe('browser settings search copy', () => {
  it('uses macOS shortcut symbols for Link Routing copy and search metadata', () => {
    expect(getBrowserLinkRoutingShortcutLabel({ isMac: true })).toBe('⇧⌘-click')

    const description = getBrowserLinkRoutingDescription({ isMac: true })
    expect(description).toContain('⇧⌘-click')
    expect(description).not.toContain('Cmd/Ctrl')
    // The copy is translated: a leaked `{{...}}` means the interpolation name drifted from the catalog.
    expect(description).not.toMatch(/\{\{.+?\}\}/)

    const linkRoutingEntry = getBrowserPaneSearchEntries({ isMac: true }).find(
      (entry) => entry.title === 'Link Routing'
    )
    expect(linkRoutingEntry?.description).toBe(getBrowserLinkRoutingDescription({ isMac: true }))
    expect(linkRoutingEntry?.keywords).toContain('cmd')
    expect(linkRoutingEntry?.keywords).not.toContain('ctrl')

    const defaultZoomEntry = getBrowserPaneSearchEntries({ isMac: true }).find(
      (entry) => entry.title === 'Default Zoom'
    )
    expect(defaultZoomEntry?.keywords).toContain('zoom')
  })

  it('uses Ctrl shortcut text for Link Routing copy and search metadata off macOS', () => {
    expect(getBrowserLinkRoutingShortcutLabel({ isMac: false })).toBe('Shift+Ctrl+click')

    const description = getBrowserLinkRoutingDescription({ isMac: false })
    expect(description).toContain('Shift+Ctrl+click')
    expect(description).not.toContain('Cmd/Ctrl')
    expect(description).not.toMatch(/\{\{.+?\}\}/)

    const linkRoutingEntry = getBrowserPaneSearchEntries({ isMac: false }).find(
      (entry) => entry.title === 'Link Routing'
    )
    expect(linkRoutingEntry?.description).toBe(getBrowserLinkRoutingDescription({ isMac: false }))
    expect(linkRoutingEntry?.keywords).toContain('ctrl')
    expect(linkRoutingEntry?.keywords).not.toContain('cmd')

    const terminalActionsEntry = getBrowserPaneSearchEntries({ isMac: false }).find(
      (entry) => entry.title === 'Terminal URL clicks'
    )
    expect(terminalActionsEntry?.description).toContain('detected URLs')
    expect(terminalActionsEntry?.keywords).toEqual(
      getTerminalLinkActionSearchKeywords({ isMac: false })
    )
    expect(terminalActionsEntry?.keywords).toContain('browser')
    expect(terminalActionsEntry?.keywords).toContain('ctrl')
  })

  // Default-off inversion must preserve existing copy byte-for-byte.
  it('keeps the pre-feature wording while inverting is off', () => {
    expect(getBrowserLinkRoutingDescription({ isMac: true })).toBe(
      "Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor. ⇧⌘-click always uses your system browser."
    )
    expect(getBrowserLinkRoutingDescription({ isMac: false })).toContain(
      'Shift+Ctrl+click always uses your system browser.'
    )
  })

  // Once inversion can route to Orca, the parent row cannot claim the chord always uses the system browser.
  it('drops the modifier claim once inverting is on', () => {
    const description = getBrowserLinkRoutingDescription({ isMac: true }, true)
    expect(description).not.toContain('click')
    expect(description).not.toContain('system browser')
  })
})

describe('browser link routing modifier copy', () => {
  // BrowserPane indexes entries by position; reordering silently changes which rows search reveals.
  it('keeps the search entry order BrowserPane indexes by position', () => {
    expect(getBrowserPaneSearchEntries({ isMac: true }).map((entry) => entry.title)).toEqual([
      'Default Home Page',
      'Default Search Engine',
      'Default Zoom',
      'Link Routing',
      'Hold Shift to open in Orca',
      'Terminal URL clicks',
      'Localhost Worktree Labels',
      'Session & Cookies',
      'Remote server workspaces',
      'SSH workspaces',
      'Browser identity',
      'Site permissions',
      'Profile for new tabs',
      'Open links in the background'
    ])
  })

  it('names the destination the modifier actually reaches', () => {
    expect(getLinkRoutingModifierTitle(false)).toBe('Hold Shift to open in Orca')
    expect(getLinkRoutingModifierTitle(true)).toBe('Hold Shift to open in your web browser')
  })

  it('describes the modifier with the platform chord', () => {
    expect(getLinkRoutingModifierDescription({ openLinksInApp: false, isMac: true })).toContain(
      '⇧⌘'
    )
    expect(getLinkRoutingModifierDescription({ openLinksInApp: false, isMac: false })).toContain(
      'Shift+Ctrl'
    )
  })

  it('points the description at Orca only when links currently open externally', () => {
    expect(getLinkRoutingModifierDescription({ openLinksInApp: false, isMac: true })).toContain(
      "Orca's built-in browser"
    )
    expect(getLinkRoutingModifierDescription({ openLinksInApp: true, isMac: true })).toContain(
      'system browser'
    )
  })

  // Default-off inversion needs enabled-state wording rather than promising current behavior.
  it('phrases the Orca branch as enabled-state copy', () => {
    expect(getLinkRoutingModifierDescription({ openLinksInApp: false, isMac: true })).toContain(
      'When enabled'
    )
  })

  // Index both routing titles because the catalog builds only the false-state variant.
  it('indexes both titles so the row is findable in either routing state', () => {
    const entry = getBrowserPaneSearchEntries({ isMac: true })[4]
    expect(entry?.keywords).toContain(getLinkRoutingModifierTitle(true))
  })
})

// Placeholder checks cannot detect untranslated English literals; require actual localized descriptions.
describe('Link Routing description localization', () => {
  const KEY = 'auto.components.settings.BrowserLinkRoutingSetting.description'
  const BASE_KEY = 'auto.components.settings.BrowserLinkRoutingSetting.descriptionBase'

  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the Korean copy with the shortcut interpolated', async () => {
    const koCopy = (
      ko.auto.components.settings.BrowserLinkRoutingSetting as unknown as Record<string, string>
    )['description']
    expect(koCopy).toBeTruthy()
    expect(koCopy).toContain('{{shortcut}}')

    i18n.addResourceBundle('ko', 'translation', ko, true, true)
    await i18n.changeLanguage('ko')

    const description = getBrowserLinkRoutingDescription({ isMac: true })
    expect(description).toBe(koCopy.replace('{{shortcut}}', '⇧⌘-click'))
    expect(description).not.toMatch(/\{\{.+?\}\}/)
    expect(description).not.toContain("Orca's built-in browser")

    // The entry title is localized too, so match on the description instead.
    const entry = getBrowserPaneSearchEntries({ isMac: true }).find(
      (item) => item.description === description
    )
    expect(entry).toBeDefined()

    await i18n.changeLanguage('en')
    expect(getBrowserLinkRoutingDescription({ isMac: true })).toContain("Orca's built-in browser")
  })

  it('renders the Korean copy for the invert-on variant', async () => {
    const koBase = (
      ko.auto.components.settings.BrowserLinkRoutingSetting as unknown as Record<string, string>
    )['descriptionBase']
    expect(koBase).toBeTruthy()

    i18n.addResourceBundle('ko', 'translation', ko, true, true)
    await i18n.changeLanguage('ko')

    const description = getBrowserLinkRoutingDescription({ isMac: true }, true)
    expect(description).toBe(koBase)
    expect(description).not.toContain("Orca's built-in browser")
  })

  it('uses the catalog key rather than an inline literal', () => {
    // Read en.json: runtime resources omit English entries reconstructible from defaults, but translators still need catalog keys.
    expect(lookupEnglishCatalog(KEY)).toBeTruthy()
    expect(lookupEnglishCatalog(BASE_KEY)).toBeTruthy()
  })
})
