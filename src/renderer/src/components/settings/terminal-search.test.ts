import { describe, expect, it } from 'vitest'
import { getTerminalPaneSearchEntries } from './terminal-search'
import { getAppearancePaneSearchEntries, getSidebarEntries } from './appearance-search'
import { getWorkspaceCardLayoutEntry } from './appearance-sidebar-search'
import { matchesSettingsSearch } from './settings-search'

describe('getTerminalPaneSearchEntries', () => {
  it('includes the Windows right-click setting on Windows', () => {
    const entries = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    expect(entries.some((entry) => entry.title === 'Right-click to paste')).toBe(true)
  })

  it('includes the PowerShell version setting on Windows', () => {
    const entries = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    expect(entries.some((entry) => entry.title === 'PowerShell Version')).toBe(true)
  })

  it('keeps Windows host entries separate from Windows client entries', () => {
    const entries = getTerminalPaneSearchEntries({
      isWindows: false,
      isWindowsTerminalHost: true,
      isMac: false
    })

    expect(entries.some((entry) => entry.title === 'Default Shell')).toBe(true)
    expect(entries.some((entry) => entry.title === 'PowerShell Version')).toBe(true)
    expect(entries.some((entry) => entry.title === 'Right-click to paste')).toBe(false)
  })

  it('omits legacy WSL distribution terminal settings on Windows', () => {
    const entries = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    expect(entries.some((entry) => entry.title === 'WSL Distribution')).toBe(false)
    expect(matchesSettingsSearch('ubuntu distro', entries)).toBe(false)
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

  it('includes the running-terminal close confirmation setting on all platforms', () => {
    const entriesWindows = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    const entriesMac = getTerminalPaneSearchEntries({ isWindows: false, isMac: true })
    const entriesLinux = getTerminalPaneSearchEntries({ isWindows: false, isMac: false })
    const hasEntry = (entries: typeof entriesWindows): boolean =>
      entries.some(
        (entry) =>
          entry.title === 'Ask Before Closing Running Terminals' &&
          matchesSettingsSearch('confirm', [entry]) &&
          matchesSettingsSearch('agent', [entry]) &&
          matchesSettingsSearch('close', [entry])
      )

    expect(hasEntry(entriesWindows)).toBe(true)
    expect(hasEntry(entriesMac)).toBe(true)
    expect(hasEntry(entriesLinux)).toBe(true)
  })

  it('keeps terminal appearance settings in the Appearance search index', () => {
    const entriesWindows = getTerminalPaneSearchEntries({ isWindows: true, isMac: false })
    const entriesMac = getTerminalPaneSearchEntries({ isWindows: false, isMac: true })
    const entriesLinux = getTerminalPaneSearchEntries({ isWindows: false, isMac: false })

    expect(entriesWindows.some((entry) => entry.title === 'Import from Ghostty')).toBe(false)
    expect(entriesMac.some((entry) => entry.title === 'Font Size')).toBe(false)
    expect(entriesLinux.some((entry) => entry.title === 'Dark Theme')).toBe(false)
    expect(
      getAppearancePaneSearchEntries().some((entry) => entry.title === 'Import from Ghostty')
    ).toBe(true)
    expect(getAppearancePaneSearchEntries().some((entry) => entry.title === 'Font Size')).toBe(true)
    expect(getAppearancePaneSearchEntries().some((entry) => entry.title === 'Dark Theme')).toBe(
      true
    )
  })

  it('omits the Warp import appearance entry when desktop-only controls are hidden', () => {
    const desktopEntries = getAppearancePaneSearchEntries({ showWarpImport: true })
    const webEntries = getAppearancePaneSearchEntries({ showWarpImport: false })

    expect(desktopEntries.some((entry) => entry.title === 'Import themes from Warp')).toBe(true)
    expect(webEntries.some((entry) => entry.title === 'Import themes from Warp')).toBe(false)
    expect(webEntries.some((entry) => entry.title === 'Import from Ghostty')).toBe(true)
  })

  it('includes the system tray appearance entry only when desktop tray controls are shown', () => {
    const desktopEntries = getAppearancePaneSearchEntries({ showSystemTray: true })
    const webEntries = getAppearancePaneSearchEntries({ showSystemTray: false })

    expect(desktopEntries.some((entry) => entry.title === 'Minimize to Tray on Close')).toBe(true)
    expect(webEntries.some((entry) => entry.title === 'Minimize to Tray on Close')).toBe(false)
    expect(matchesSettingsSearch('tray', desktopEntries)).toBe(true)
    expect(matchesSettingsSearch('tray', webEntries)).toBe(false)
  })

  it('keeps sidebar shortcut restore settings in the Appearance search index', () => {
    const automationsEntry = getSidebarEntries().find(
      (entry) => entry.title === 'Show Automations Button'
    )

    expect(automationsEntry).toBeDefined()
    expect(automationsEntry?.keywords).toEqual(
      expect.arrayContaining(['automations', 'sidebar', 'hide', 'show'])
    )
    expect(
      getAppearancePaneSearchEntries().some((entry) => entry.title === 'Show Automations Button')
    ).toBe(true)
  })

  it('includes workspace card layout guidance in the sidebar and Appearance catalogs', () => {
    const entry = getWorkspaceCardLayoutEntry()

    expect(getSidebarEntries()).toContainEqual(entry)
    expect(getAppearancePaneSearchEntries()).toContainEqual(entry)
  })

  it.each(['compact', 'compact display', 'workspace cards', 'sidebar', 'card layout'])(
    'matches workspace card layout search for %s',
    (query) => {
      expect(matchesSettingsSearch(query, getWorkspaceCardLayoutEntry())).toBe(true)
    }
  )

  it('matches the Appearance catalog for compact workspace card searches', () => {
    expect(matchesSettingsSearch('compact', getAppearancePaneSearchEntries())).toBe(true)
  })
})
