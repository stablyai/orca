/** Interface palettes layered over Orca's light/dark tokens; CSS lives in assets/interface-themes.css. */
export type InterfaceThemeOption = { id: string; label: string }

export const DEFAULT_INTERFACE_THEME_ID = 'default'

export const INTERFACE_THEMES_DARK: readonly InterfaceThemeOption[] = [
  { id: DEFAULT_INTERFACE_THEME_ID, label: 'Orca' },
  { id: 'catppuccin-frappe', label: 'Catppuccin Frappé' },
  { id: 'catppuccin-macchiato', label: 'Catppuccin Macchiato' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' }
]

export const INTERFACE_THEMES_LIGHT: readonly InterfaceThemeOption[] = [
  { id: DEFAULT_INTERFACE_THEME_ID, label: 'Orca' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte' }
]
