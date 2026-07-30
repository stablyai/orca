import { describe, expect, it } from 'vitest'
import { getBrowserLinkRoutingDescription, getBrowserPaneSearchEntries } from './browser-search'
import {
  getLinkRoutingModifierDescription,
  getLinkRoutingModifierTitle
} from './browser-link-routing-modifier-copy'

describe('browser settings search copy', () => {
  it('uses macOS shortcut keywords for Link Routing search metadata', () => {
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

  it('uses Ctrl shortcut keywords for Link Routing search metadata off macOS', () => {
    const linkRoutingEntry = getBrowserPaneSearchEntries({ isMac: false }).find(
      (entry) => entry.title === 'Link Routing'
    )
    expect(linkRoutingEntry?.description).toBe(getBrowserLinkRoutingDescription({ isMac: false }))
    expect(linkRoutingEntry?.keywords).toContain('ctrl')
    expect(linkRoutingEntry?.keywords).not.toContain('cmd')
  })

  // Why: shipping the opt-in must not reword this row for anyone who never enables
  // it, so the default output has to stay byte-identical to the pre-feature copy.
  it('keeps the pre-feature wording while inverting is off', () => {
    expect(getBrowserLinkRoutingDescription({ isMac: true })).toBe(
      "Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor. ⇧⌘-click always uses your system browser."
    )
    expect(getBrowserLinkRoutingDescription({ isMac: false })).toContain(
      'Shift+Ctrl+click always uses your system browser.'
    )
  })

  // Why: "always" would be a lie once the chord can land in Orca, so the nested row
  // takes over the claim.
  it('drops the modifier claim once inverting is on', () => {
    const description = getBrowserLinkRoutingDescription({ isMac: true }, true)
    expect(description).not.toContain('click')
    expect(description).not.toContain('system browser')
  })
})

describe('browser link routing modifier copy', () => {
  // Why: BrowserPane gates each row on getBrowserPaneSearchEntries()[n], so a
  // reordered or inserted entry silently shows the wrong row for a search.
  it('keeps the search entry order BrowserPane indexes by position', () => {
    expect(getBrowserPaneSearchEntries({ isMac: true }).map((entry) => entry.title)).toEqual([
      'Default Home Page',
      'Default Search Engine',
      'Default Zoom',
      'Link Routing',
      'Hold Shift to open in Orca',
      'Localhost Worktree Labels',
      'Session & Cookies'
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

  // Why: the toggle is off by default, so present-tense "opens one in Orca" would
  // describe behavior the user does not have yet.
  it('phrases the Orca branch as enabled-state copy', () => {
    expect(getLinkRoutingModifierDescription({ openLinksInApp: false, isMac: true })).toContain(
      'When enabled'
    )
  })

  // Why: the entry is built with openLinksInApp false, so without this the row is
  // unfindable by the title it actually renders when Link Routing is on.
  it('indexes both titles so the row is findable in either routing state', () => {
    const entry = getBrowserPaneSearchEntries({ isMac: true })[4]
    expect(entry?.keywords).toContain(getLinkRoutingModifierTitle(true))
  })
})
