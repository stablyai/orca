import type { SettingsSearchEntry } from './settings-search'

export const BROWSER_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Default Home Page',
    description: 'URL opened when creating a new browser tab. Leave empty to open a blank tab.',
    keywords: ['browser', 'home', 'homepage', 'default', 'url', 'new tab', 'blank', 'landing']
  },
  {
    title: 'Terminal Link Routing',
    description:
      'Cmd/Ctrl+click opens terminal http(s) links in Orca. Shift+Cmd/Ctrl+click uses the system browser.',
    keywords: ['browser', 'preview', 'links', 'localhost', 'webview', 'shift', 'cmd', 'ctrl']
  },
  {
    title: 'Session & Cookies',
    description:
      'Import cookies from Chrome, Edge, or other browsers to use existing logins inside Orca.',
    keywords: [
      'browser',
      'cookies',
      'session',
      'import',
      'auth',
      'login',
      'chrome',
      'edge',
      'arc',
      'profile'
    ]
  }
]
