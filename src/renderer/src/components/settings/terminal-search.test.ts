import { describe, expect, it } from 'vitest'
import { getTerminalPaneSearchEntries } from './terminal-search'
import { APPEARANCE_PANE_SEARCH_ENTRIES } from './appearance-search'

describe('getTerminalPaneSearchEntries', () => {
  it('includes the Windows right-click setting on Windows', () => {
    const entries = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    expect(entries.some((entry) => entry.title === 'Right-click to paste')).toBe(true)
  })

  it('includes the PowerShell version setting on Windows', () => {
    const entries = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    expect(entries.some((entry) => entry.title === 'PowerShell Version')).toBe(true)
  })

  it('omits the Windows right-click setting elsewhere', () => {
    const entries = getTerminalPaneSearchEntries({ isWindows: false, isMac: false })
    expect(entries.some((entry) => entry.title === 'Right-click to paste')).toBe(false)
  })

  it('omits the PowerShell version setting elsewhere', () => {
    const entries = getTerminalPaneSearchEntries({ isWindows: false, isMac: false })
    expect(entries.some((entry) => entry.title === 'PowerShell Version')).toBe(false)
  })

  it('includes the Option as Alt setting on macOS', () => {
    const entries = getTerminalPaneSearchEntries({ isWindows: false, isMac: true })
    expect(entries.some((entry) => entry.title === 'Option as Alt')).toBe(true)
  })

  it('omits the Option as Alt setting on non-macOS', () => {
    const entries = getTerminalPaneSearchEntries({ isWindows: false, isMac: false })
    expect(entries.some((entry) => entry.title === 'Option as Alt')).toBe(false)
  })

  it('includes the JIS Yen mapping setting only on macOS', () => {
    const entriesMac = getTerminalPaneSearchEntries({ isWindows: false, isMac: true })
    const entriesLinux = getTerminalPaneSearchEntries({ isWindows: false, isMac: false })

    expect(entriesMac.some((entry) => entry.title === 'JIS Yen (¥) to Backslash (\\)')).toBe(true)
    expect(entriesLinux.some((entry) => entry.title === 'JIS Yen (¥) to Backslash (\\)')).toBe(
      false
    )
  })

  it('includes the Manage Sessions entry on all platforms', () => {
    const entriesWindows = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    const entriesMac = getTerminalPaneSearchEntries({ isWindows: false, isMac: true })
    const entriesLinux = getTerminalPaneSearchEntries({ isWindows: false, isMac: false })
    expect(entriesWindows.some((entry) => entry.title === 'Manage Sessions')).toBe(true)
    expect(entriesMac.some((entry) => entry.title === 'Manage Sessions')).toBe(true)
    expect(entriesLinux.some((entry) => entry.title === 'Manage Sessions')).toBe(true)
  })

  it('includes the OSC 52 clipboard setting on all platforms', () => {
    const entriesWindows = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    const entriesMac = getTerminalPaneSearchEntries({ isWindows: false, isMac: true })
    const entriesLinux = getTerminalPaneSearchEntries({ isWindows: false, isMac: false })
    expect(
      entriesWindows.some((entry) => entry.title === 'Allow TUI Clipboard Writes (OSC 52)')
    ).toBe(true)
    expect(entriesMac.some((entry) => entry.title === 'Allow TUI Clipboard Writes (OSC 52)')).toBe(
      true
    )
    expect(
      entriesLinux.some((entry) => entry.title === 'Allow TUI Clipboard Writes (OSC 52)')
    ).toBe(true)
  })

  it('keeps terminal appearance settings in the Appearance search index', () => {
    const entriesWindows = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    const entriesMac = getTerminalPaneSearchEntries({ isWindows: false, isMac: true })
    const entriesLinux = getTerminalPaneSearchEntries({ isWindows: false, isMac: false })

    expect(entriesWindows.some((entry) => entry.title === 'Import from Ghostty')).toBe(false)
    expect(entriesMac.some((entry) => entry.title === 'Font Size')).toBe(false)
    expect(entriesLinux.some((entry) => entry.title === 'Dark Theme')).toBe(false)
    expect(
      APPEARANCE_PANE_SEARCH_ENTRIES.some((entry) => entry.title === 'Import from Ghostty')
    ).toBe(true)
    expect(APPEARANCE_PANE_SEARCH_ENTRIES.some((entry) => entry.title === 'Font Size')).toBe(true)
    expect(APPEARANCE_PANE_SEARCH_ENTRIES.some((entry) => entry.title === 'Dark Theme')).toBe(true)
  })
})
