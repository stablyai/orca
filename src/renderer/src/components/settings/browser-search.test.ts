import { beforeEach, describe, expect, it } from 'vitest'

import ko from '@/i18n/locales/ko.json'
import { i18n } from '@/i18n/i18n'
import {
  getBrowserLinkRoutingDescription,
  getBrowserLinkRoutingShortcutLabel,
  getBrowserPaneSearchEntries
} from './browser-search'

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
    expect(linkRoutingEntry?.description).toBe(description)
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
    expect(linkRoutingEntry?.description).toBe(description)
    expect(linkRoutingEntry?.keywords).toContain('ctrl')
    expect(linkRoutingEntry?.keywords).not.toContain('cmd')
  })
})

// The bug this file guards: the Link Routing description was a bare template
// literal, so it stayed English in every locale. Asserting only "no {{...}} leaked"
// cannot catch that — the English literal has no placeholder either.
describe('Link Routing description localization', () => {
  const KEY = 'auto.components.settings.browser.search.904ce58440'

  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the Korean copy with the shortcut interpolated', async () => {
    const koCopy = (
      ko.auto.components.settings.browser.search as unknown as Record<string, string>
    )['904ce58440']
    expect(koCopy).toBeTruthy()
    expect(koCopy).toContain('{{value0}}')

    i18n.addResourceBundle('ko', 'translation', ko, true, true)
    await i18n.changeLanguage('ko')

    const description = getBrowserLinkRoutingDescription({ isMac: true })
    expect(description).toBe(koCopy.replace('{{value0}}', '⇧⌘-click'))
    expect(description).not.toMatch(/\{\{.+?\}\}/)
    // Fails when the copy is a hardcoded English literal.
    expect(description).not.toContain("Orca's built-in browser")

    // The entry title is localized too, so match on the description instead.
    const entry = getBrowserPaneSearchEntries({ isMac: true }).find(
      (item) => item.description === description
    )
    expect(entry).toBeDefined()

    await i18n.changeLanguage('en')
    expect(getBrowserLinkRoutingDescription({ isMac: true })).toContain(
      "Orca's built-in browser"
    )
  })

  it('uses the catalog key rather than an inline literal', () => {
    expect(i18n.exists(KEY)).toBe(true)
  })
})
