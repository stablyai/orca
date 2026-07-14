import type { GlobalSettings } from '../../../shared/types'

export type MonacoEditorTheme = 'vs' | 'vs-dark' | 'hc-light' | 'hc-black' | 'orca-dracula'

export function resolveMonacoEditorTheme(
  preference: GlobalSettings['editorTheme'],
  appUsesDarkTheme: boolean
): MonacoEditorTheme {
  switch (preference) {
    case 'light':
      return 'vs'
    case 'dark':
      return 'vs-dark'
    case 'high-contrast-light':
      return 'hc-light'
    case 'high-contrast-dark':
      return 'hc-black'
    case 'dracula':
      return 'orca-dracula'
    case 'app':
    case undefined:
      return appUsesDarkTheme ? 'vs-dark' : 'vs'
  }
}
