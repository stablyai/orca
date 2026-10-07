import type { AppThemePreset } from '../../../shared/app-theme-types'
import { DEFAULT_TERMINAL_THEME_DARK } from '../../../shared/terminal-theme-selection'

export const STANDARD_THEME_PRESETS: readonly AppThemePreset[] = [
  {
    id: 'default',
    name: 'Default (Orca)',
    mode: 'dark',
    description: 'Clean monochrome palette',
    swatches: {
      background: '#0a0a0a',
      card: '#171717',
      primary: '#e5e5e5',
      accent: '#404040'
    },
    matchingTerminalTheme: DEFAULT_TERMINAL_THEME_DARK
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    description: 'Vampire theme with purple & cyan accents',
    swatches: {
      background: '#282a36',
      card: '#343746',
      primary: '#bd93f9',
      accent: '#8be9fd'
    },
    matchingTerminalTheme: 'Dracula'
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    description: 'Arctic, north-bluish clean palette',
    swatches: {
      background: '#2e3440',
      card: '#3b4252',
      primary: '#88c0d0',
      accent: '#81a1c1'
    },
    matchingTerminalTheme: 'Nord'
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    description: 'Neon nightlights in dark blue cityscapes',
    swatches: {
      background: '#1a1b26',
      card: '#24283b',
      primary: '#7aa2f7',
      accent: '#bb9af7'
    },
    matchingTerminalTheme: 'Tokyo Night'
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    description: 'Soothing warm dark pastel palette',
    swatches: {
      background: '#1e1e2e',
      card: '#313244',
      primary: '#cba6f7',
      accent: '#f5c2e7'
    },
    matchingTerminalTheme: 'Catppuccin Mocha'
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    description: 'Warm soothing pastel light palette',
    swatches: {
      background: '#eff1f5',
      card: '#e6e9ef',
      primary: '#8839ef',
      accent: '#ea76cb'
    },
    matchingTerminalTheme: 'Catppuccin Latte'
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    mode: 'dark',
    description: 'Low-contrast precision palette for low-light environments',
    swatches: {
      background: '#002b36',
      card: '#073642',
      primary: '#268bd2',
      accent: '#2aa198'
    },
    matchingTerminalTheme: 'Solarized Dark'
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    description: 'Classic warm parchment with high readability',
    swatches: {
      background: '#fdf6e3',
      card: '#eee8d5',
      primary: '#268bd2',
      accent: '#2aa198'
    },
    matchingTerminalTheme: 'Solarized Light'
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    mode: 'dark',
    description: 'Official GitHub dark mode canvas and borders',
    swatches: {
      background: '#0d1117',
      card: '#161b22',
      primary: '#58a6ff',
      accent: '#388bfd'
    },
    matchingTerminalTheme: 'GitHub Dark'
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    mode: 'light',
    description: 'Crisp white canvas with classic GitHub blue',
    swatches: {
      background: '#ffffff',
      card: '#f6f8fa',
      primary: '#0969da',
      accent: '#218bff'
    },
    matchingTerminalTheme: 'GitHub Light'
  },
  {
    id: 'liquid-glass-dark',
    name: 'iOS 27 Liquid Glass Dark',
    mode: 'dark',
    description: 'Translucent neon cyan glass with deep obsidian surfaces',
    swatches: {
      background: '#080d14',
      card: '#101826',
      primary: '#00f0ff',
      accent: '#1c2b42'
    },
    matchingTerminalTheme: 'iOS 27 Liquid Glass Dark'
  },
  {
    id: 'liquid-glass-light',
    name: 'iOS 27 Liquid Glass Light',
    mode: 'light',
    description: 'Translucent azure glass with clean frosted surfaces',
    swatches: {
      background: '#f0f4f9',
      card: '#e4ecf6',
      primary: '#007aff',
      accent: '#cbdbee'
    },
    matchingTerminalTheme: 'iOS 27 Liquid Glass Light'
  },
  {
    id: 'material-dark',
    name: 'Material 3 Dark',
    mode: 'dark',
    description: 'Google Material You tonal palette with violet accents',
    swatches: {
      background: '#141218',
      card: '#211f26',
      primary: '#d0bcff',
      accent: '#4f378b'
    },
    matchingTerminalTheme: 'Material 3 Dark'
  },
  {
    id: 'material-light',
    name: 'Material 3 Light',
    mode: 'light',
    description: 'Clean Google Material You surface with deep violet accents',
    swatches: {
      background: '#fef7ff',
      card: '#f3edf7',
      primary: '#6750a4',
      accent: '#eaddff'
    },
    matchingTerminalTheme: 'Material 3 Light'
  }
]
