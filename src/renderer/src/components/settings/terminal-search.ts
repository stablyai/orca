import type { SettingsSearchEntry } from './settings-search'

export const TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Font Size',
    description: 'Default terminal font size for new panes and live updates.',
    keywords: ['terminal', 'typography', 'text size']
  },
  {
    title: 'Font Family',
    description: 'Default terminal font family for new panes and live updates.',
    keywords: ['terminal', 'typography', 'font']
  },
  {
    title: 'Font Weight',
    description: 'Controls the terminal text font weight.',
    keywords: ['terminal', 'typography', 'weight']
  }
]

export const TERMINAL_CURSOR_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Cursor Shape',
    description: 'Default cursor appearance for Orca terminal panes.',
    keywords: ['terminal', 'cursor', 'bar', 'block', 'underline']
  },
  {
    title: 'Blinking Cursor',
    description: 'Uses the blinking variant of the selected cursor shape.',
    keywords: ['terminal', 'cursor', 'blink']
  }
]

export const TERMINAL_PANE_STYLE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Inactive Pane Opacity',
    description: 'Opacity applied to panes that are not currently active.',
    keywords: ['pane', 'opacity', 'dimming']
  },
  {
    title: 'Divider Thickness',
    description: 'Thickness of the pane divider line.',
    keywords: ['pane', 'divider', 'thickness']
  },
  {
    title: 'Focus Follows Mouse',
    description:
      "Hovering a terminal pane activates it without needing to click. Mirrors Ghostty's focus-follows-mouse setting. Selections and window switching stay safe.",
    keywords: ['focus', 'follows', 'mouse', 'hover', 'pane', 'ghostty', 'active']
  }
]

export const TERMINAL_DARK_THEME_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Dark Theme',
    description: 'Choose the terminal theme used in dark mode.',
    keywords: ['terminal', 'theme', 'dark', 'preview']
  },
  {
    title: 'Dark Divider Color',
    description: 'Controls the split divider line between panes in dark mode.',
    keywords: ['terminal', 'divider', 'dark', 'color']
  }
]

export const TERMINAL_LIGHT_THEME_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Use Separate Theme In Light Mode',
    description: 'When disabled, light mode reuses the dark terminal theme.',
    keywords: ['terminal', 'light mode', 'theme']
  },
  {
    title: 'Light Theme',
    description: 'Choose the theme used when Orca is in light mode.',
    keywords: ['terminal', 'theme', 'light', 'preview']
  },
  {
    title: 'Light Divider Color',
    description: 'Controls the split divider line between panes in light mode.',
    keywords: ['terminal', 'divider', 'light', 'color']
  }
]

export const TERMINAL_ADVANCED_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Scrollback Size',
    description: 'Maximum terminal scrollback buffer size.',
    keywords: ['terminal', 'scrollback', 'buffer', 'memory']
  }
]

export const TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Setup Script Location',
    description:
      "Where the repository setup script runs when a new workspace is created: a vertical split (default), a horizontal split, or a background tab titled 'Setup'.",
    keywords: [
      'setup',
      'script',
      'workspace',
      'split',
      'horizontal',
      'vertical',
      'tab',
      'new',
      'location',
      'launch'
    ]
  }
]

export const TERMINAL_WINDOWS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Right-click to paste',
    description:
      'On Windows, right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu.',
    keywords: ['terminal', 'windows', 'right click', 'paste', 'context menu']
  }
]

export const TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY = TERMINAL_WINDOWS_SEARCH_ENTRIES

export function getTerminalPaneSearchEntries(isWindows: boolean): SettingsSearchEntry[] {
  // Why: the settings search index must mirror the visible controls. Keeping
  // the Windows-only paste toggle out of non-Windows search results prevents
  // users from landing on an option the UI intentionally hides.
  return [
    ...TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES,
    ...TERMINAL_CURSOR_SEARCH_ENTRIES,
    ...TERMINAL_PANE_STYLE_SEARCH_ENTRIES,
    ...(isWindows ? TERMINAL_WINDOWS_SEARCH_ENTRIES : []),
    ...TERMINAL_DARK_THEME_SEARCH_ENTRIES,
    ...TERMINAL_LIGHT_THEME_SEARCH_ENTRIES,
    ...TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES,
    ...TERMINAL_ADVANCED_SEARCH_ENTRIES
  ]
}
