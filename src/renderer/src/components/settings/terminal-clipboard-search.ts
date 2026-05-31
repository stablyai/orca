import type { SettingsSearchEntry } from './settings-search'

export const TERMINAL_CLIPBOARD_SEARCH_ENTRIES: SettingsSearchEntry[] = [
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
  },
  {
    title: 'Allow TUI Clipboard Writes (OSC 52)',
    description:
      'Let programs in the terminal copy to the system clipboard through OSC 52, including over SSH.',
    keywords: [
      'osc 52',
      'osc52',
      'clipboard',
      'tmux',
      'neovim',
      'nvim',
      'fzf',
      'ssh',
      'remote',
      'copy',
      'paste'
    ]
  }
]
