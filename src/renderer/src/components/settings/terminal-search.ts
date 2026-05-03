import type { SettingsSearchEntry } from './settings-search'
import { TERMINAL_WINDOWS_SEARCH_ENTRIES } from './terminal-windows-search'

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
  },
  {
    title: 'Line Height',
    description: 'Controls the terminal line height multiplier.',
    keywords: ['terminal', 'typography', 'line height', 'spacing']
  },
  {
    title: 'Font Ligatures',
    description:
      'Render programming ligatures (e.g. => → ≠ ≥) for fonts that ship them. "Auto" enables ligatures only for known ligature fonts (Fira Code, JetBrains Mono, Cascadia Code, Iosevka, etc.).',
    keywords: [
      'terminal',
      'typography',
      'ligatures',
      'ligature',
      'fira code',
      'jetbrains mono',
      'cascadia code',
      'iosevka',
      'calt',
      'font features'
    ]
  }
]

export const TERMINAL_RENDERING_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'GPU Acceleration',
    description:
      'Controls whether the terminal uses xterm.js WebGL rendering. Auto mirrors VS Code: try GPU and fall back to DOM if WebGL fails.',
    keywords: [
      'terminal',
      'gpu',
      'acceleration',
      'webgl',
      'renderer',
      'rendering',
      'graphics',
      'linux',
      'vscode'
    ]
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
  },
  {
    title: 'Cursor Opacity',
    description: 'Opacity of the terminal cursor.',
    keywords: ['terminal', 'cursor', 'opacity', 'transparency']
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
  },
  {
    title: 'Copy on Select',
    description:
      'Automatically copy terminal selections to the clipboard as soon as a selection is made.',
    keywords: [
      'clipboard',
      'copy',
      'select',
      'selection',
      'auto',
      'automatic',
      'x11',
      'linux',
      'gnome',
      'paste'
    ]
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
  },
  {
    title: 'Word Separators',
    description: 'Characters treated as word boundaries for double-click selection.',
    keywords: ['word', 'separator', 'boundary', 'double-click', 'selection']
  }
]

export const TERMINAL_MAC_OPTION_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Option as Alt',
    description:
      "Controls whether the macOS Option key sends Alt/Esc sequences or composes characters. Mirrors Ghostty's macos-option-as-alt.",
    keywords: [
      'terminal',
      'option',
      'alt',
      'key',
      'meta',
      'compose',
      'mac',
      'macos',
      'keyboard',
      'german',
      'international',
      'readline',
      'ghostty'
    ]
  }
]

export const TERMINAL_GHOSTTY_IMPORT_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Import from Ghostty',
    description: 'One-time import of supported Ghostty terminal settings.',
    keywords: ['ghostty', 'import', 'terminal', 'config', 'settings']
  }
]

export const MANAGE_SESSIONS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Manage Sessions',
    description:
      'Recover from frozen terminals by killing sessions, clearing saved scrollback, or restarting the daemon.',
    keywords: [
      'daemon',
      'pty',
      'sessions',
      'manage',
      'kill',
      'kill all',
      'clear',
      'history',
      'scrollback',
      'restart',
      'terminal',
      'recover',
      'frozen',
      'unfreeze'
    ]
  }
]

export const TERMINAL_WINDOW_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Background Opacity',
    description: 'Controls the transparency of the terminal background.',
    keywords: ['opacity', 'transparency', 'background', 'alpha']
  },
  {
    title: 'Window Blur',
    description: 'Apply background blur to the terminal window. Requires restart.',
    keywords: ['window', 'blur', 'background', 'transparency', 'vibrancy']
  },
  {
    title: 'Horizontal Padding',
    description: 'Horizontal padding around the terminal grid in pixels.',
    keywords: ['padding', 'horizontal', 'spacing', 'margin']
  },
  {
    title: 'Vertical Padding',
    description: 'Vertical padding around the terminal grid in pixels.',
    keywords: ['padding', 'vertical', 'spacing', 'margin']
  },
  {
    title: 'Hide Mouse While Typing',
    description: 'Hide the mouse cursor when typing in the terminal.',
    keywords: ['mouse', 'hide', 'typing', 'cursor']
  },
  {
    title: 'Color Overrides',
    description: 'Override individual terminal colors.',
    keywords: ['color', 'override', 'ansi', 'palette', 'theme']
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

export function getTerminalPaneSearchEntries(platform: {
  isWindows: boolean
  isMac: boolean
}): SettingsSearchEntry[] {
  // Why: the settings search index must mirror the visible controls. Keeping
  // platform-only controls out of other platforms' search results prevents
  // users from landing on an option the UI intentionally hides.
  return [
    ...TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES,
    ...TERMINAL_RENDERING_SEARCH_ENTRIES,
    ...TERMINAL_CURSOR_SEARCH_ENTRIES,
    ...TERMINAL_PANE_STYLE_SEARCH_ENTRIES,
    ...(platform.isWindows ? TERMINAL_WINDOWS_SEARCH_ENTRIES : []),
    ...TERMINAL_DARK_THEME_SEARCH_ENTRIES,
    ...TERMINAL_LIGHT_THEME_SEARCH_ENTRIES,
    ...TERMINAL_WINDOW_SEARCH_ENTRIES,
    ...TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES,
    ...TERMINAL_GHOSTTY_IMPORT_SEARCH_ENTRIES,
    ...MANAGE_SESSIONS_SEARCH_ENTRIES,
    ...TERMINAL_ADVANCED_SEARCH_ENTRIES,
    ...(platform.isMac ? TERMINAL_MAC_OPTION_SEARCH_ENTRIES : [])
  ]
}
