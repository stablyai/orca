export type AppThemePresetId =
  | 'default'
  | 'dracula'
  | 'nord'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'solarized-dark'
  | 'solarized-light'
  | 'github-dark'
  | 'github-light'
  | 'material-dark'
  | 'material-light'
  | 'liquid-glass-dark'
  | 'liquid-glass-light'
  | 'dala-dark'
  | 'dala-light'
  | 'discord-dark'
  | 'discord-light'
  | 'dope-security-dark'
  | 'dope-security-light'
  | 'raycast-dark'
  | 'raycast-light'
  | 'zkpass-dark'
  | 'zkpass-light'
  | 'miranda-light'
  | 'miranda-dark'

export type AppThemePreset = {
  id: AppThemePresetId
  name: string
  mode: 'dark' | 'light'
  description?: string
  swatches: {
    background: string
    card: string
    primary: string
    accent: string
  }
  matchingTerminalTheme?: string
}
