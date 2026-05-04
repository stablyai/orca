import type { SettingsSearchEntry } from './settings-search'

export const BROWSER_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Default Home Page',
    description: 'URL opened when creating a new browser tab. Leave empty to open a blank tab.',
    keywords: ['browser', 'home', 'homepage', 'default', 'url', 'new tab', 'blank', 'landing']
  },
  {
    title: 'Default Search Engine',
    description: 'Search engine used when typing non-URL text in the address bar.',
    keywords: ['browser', 'search', 'engine', 'google', 'duckduckgo', 'bing', 'omnibox', 'query']
  },
  {
    title: 'Link Routing',
    description:
      "Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor. Shift+Cmd/Ctrl+click always uses your system browser.",
    keywords: [
      'browser',
      'preview',
      'links',
      'localhost',
      'webview',
      'shift',
      'cmd',
      'ctrl',
      'markdown',
      'file',
      'editor'
    ]
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
