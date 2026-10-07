import type { AppThemePreset } from '../../../shared/app-theme-types'

export const BRAND_THEME_PRESETS: readonly AppThemePreset[] = [
  {
    id: 'dala-dark',
    name: 'Dala Dark',
    mode: 'dark',
    description: 'Void black velvet with electric iris accents',
    swatches: {
      background: '#000000',
      card: '#0d0d12',
      primary: '#8052ff',
      accent: '#ffb829'
    },
    matchingTerminalTheme: 'Dala Dark'
  },
  {
    id: 'dala-light',
    name: 'Dala Light',
    mode: 'light',
    description: 'Clean bone canvas with vivid violet accents',
    swatches: {
      background: '#f9f8fc',
      card: '#ffffff',
      primary: '#7042e8',
      accent: '#ffb829'
    },
    matchingTerminalTheme: 'Dala Light'
  },
  {
    id: 'discord-dark',
    name: 'Discord Dark',
    mode: 'dark',
    description: 'Deep cosmic void with signature blurple',
    swatches: {
      background: '#0e0f2d',
      card: '#1e214d',
      primary: '#5865f2',
      accent: '#57f287'
    },
    matchingTerminalTheme: 'Discord Dark'
  },
  {
    id: 'discord-light',
    name: 'Discord Light',
    mode: 'light',
    description: 'Crisp conversational surface with blurple anchors',
    swatches: {
      background: '#f2f3f5',
      card: '#ffffff',
      primary: '#5865f2',
      accent: '#3442d9'
    },
    matchingTerminalTheme: 'Discord Light'
  },
  {
    id: 'dope-security-dark',
    name: 'Dope Security Dark',
    mode: 'dark',
    description: 'Midnight terminal void with signal violet beacon',
    swatches: {
      background: '#090909',
      card: '#131313',
      primary: '#af50ff',
      accent: '#e1bdff'
    },
    matchingTerminalTheme: 'Dope Security Dark'
  },
  {
    id: 'dope-security-light',
    name: 'Dope Security Light',
    mode: 'light',
    description: 'Clinical high-contrast canvas with violet beacons',
    swatches: {
      background: '#f8f9fa',
      card: '#ffffff',
      primary: '#9632eb',
      accent: '#af50ff'
    },
    matchingTerminalTheme: 'Dope Security Light'
  },
  {
    id: 'raycast-dark',
    name: 'Raycast Dark',
    mode: 'dark',
    description: 'Command center void with glowing coral pulse',
    swatches: {
      background: '#040506',
      card: '#111214',
      primary: '#ff6363',
      accent: '#63a1ff'
    },
    matchingTerminalTheme: 'Raycast Dark'
  },
  {
    id: 'raycast-light',
    name: 'Raycast Light',
    mode: 'light',
    description: 'Minimalist command cockpit with coral accents',
    swatches: {
      background: '#f9f9fa',
      card: '#ffffff',
      primary: '#e64545',
      accent: '#ff6363'
    },
    matchingTerminalTheme: 'Raycast Light'
  },
  {
    id: 'zkpass-dark',
    name: 'zkPass Dark',
    mode: 'dark',
    description: 'Technical cryptography void with electric lime phosphor',
    swatches: {
      background: '#000000',
      card: '#141414',
      primary: '#c5ff4a',
      accent: '#3d3d3d'
    },
    matchingTerminalTheme: 'zkPass Dark'
  },
  {
    id: 'zkpass-light',
    name: 'zkPass Light',
    mode: 'light',
    description: 'High-contrast technical grid with cyber lime',
    swatches: {
      background: '#f7f9f2',
      card: '#ffffff',
      primary: '#6e9900',
      accent: '#c5ff4a'
    },
    matchingTerminalTheme: 'zkPass Light'
  },
  {
    id: 'miranda-light',
    name: 'Miranda Paper',
    mode: 'light',
    description: 'Warm newsprint linen paper, printer ink, and vintage sage',
    swatches: {
      background: '#cdc6be',
      card: '#dcd6ce',
      primary: '#1d1d1b',
      accent: '#96b59f'
    },
    matchingTerminalTheme: 'Miranda Paper'
  },
  {
    id: 'miranda-dark',
    name: 'Miranda Ink',
    mode: 'dark',
    description: 'Deep printer charcoal ink with aged paper typography',
    swatches: {
      background: '#141412',
      card: '#1d1d1b',
      primary: '#96b59f',
      accent: '#cf8e50'
    },
    matchingTerminalTheme: 'Miranda Ink'
  }
]
