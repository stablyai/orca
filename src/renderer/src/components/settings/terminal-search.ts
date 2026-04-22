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
  },
  {
    title: 'Line Height',
    description: 'Controls the terminal line height multiplier.',
    keywords: ['terminal', 'typography', 'line height', 'spacing']
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
    title: 'Force Hyperlink Escapes',
    description:
      'Set FORCE_HYPERLINK=1 in every terminal so tools emit OSC-8 clickable links. Turn off if your shell startup is slow.',
    keywords: [
      'terminal',
      'hyperlink',
      'link',
      'osc',
      'osc8',
      'osc-8',
      'force_hyperlink',
      'slow',
      'startup',
      'zsh',
      'zshrc',
      'oh-my-zsh',
      'p10k',
      'powerlevel10k'
    ]
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

export const TERMINAL_WINDOWS_SHELL_SEARCH_ENTRY: SettingsSearchEntry[] = [
  {
    title: 'Default Shell',
    description: 'Choose the default shell for new terminal panes on Windows.',
    keywords: ['terminal', 'windows', 'shell', 'powershell', 'cmd', 'command prompt', 'default']
  }
]

export const TERMINAL_WINDOWS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...TERMINAL_WINDOWS_SHELL_SEARCH_ENTRY,
  {
    title: 'Right-click to paste',
    description:
      'On Windows, right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu.',
    keywords: ['terminal', 'windows', 'right click', 'paste', 'context menu']
  }
]

export const TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY: SettingsSearchEntry[] = [
  {
    title: 'Right-click to paste',
    description:
      'On Windows, right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu.',
    keywords: ['terminal', 'windows', 'right click', 'paste', 'context menu']
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
    ...TERMINAL_CURSOR_SEARCH_ENTRIES,
    ...TERMINAL_PANE_STYLE_SEARCH_ENTRIES,
    ...(platform.isWindows ? TERMINAL_WINDOWS_SEARCH_ENTRIES : []),
    ...TERMINAL_DARK_THEME_SEARCH_ENTRIES,
    ...TERMINAL_LIGHT_THEME_SEARCH_ENTRIES,
    ...TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES,
    ...TERMINAL_ADVANCED_SEARCH_ENTRIES,
    ...(platform.isMac ? TERMINAL_MAC_OPTION_SEARCH_ENTRIES : [])
  ]
}
