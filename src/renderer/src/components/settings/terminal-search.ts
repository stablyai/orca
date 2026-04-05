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

export const TERMINAL_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES,
  ...TERMINAL_CURSOR_SEARCH_ENTRIES,
  ...TERMINAL_PANE_STYLE_SEARCH_ENTRIES,
  ...TERMINAL_DARK_THEME_SEARCH_ENTRIES,
  ...TERMINAL_LIGHT_THEME_SEARCH_ENTRIES,
  ...TERMINAL_ADVANCED_SEARCH_ENTRIES
]
