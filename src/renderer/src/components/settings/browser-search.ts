import type { SettingsSearchEntry } from './settings-search'

type BrowserShortcutPlatform = {
  isMac: boolean
}

function getDefaultBrowserShortcutPlatform(): BrowserShortcutPlatform {
  return {
    isMac: typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
  }
}

export function getBrowserLinkRoutingShortcutLabel(platform: BrowserShortcutPlatform): string {
  return platform.isMac ? '⇧⌘-click' : 'Shift+Ctrl+click'
}

export function getBrowserLinkRoutingDescription(platform: BrowserShortcutPlatform): string {
  return `Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor. ${getBrowserLinkRoutingShortcutLabel(platform)} always uses your system browser.`
}

export function getBrowserPaneSearchEntries(
  platform: BrowserShortcutPlatform = getDefaultBrowserShortcutPlatform()
): SettingsSearchEntry[] {
  return [
    {
      title: 'Default Home Page',
      description: 'URL opened when creating a new browser tab. Leave empty to open a blank tab.',
      keywords: ['browser', 'home', 'homepage', 'default', 'url', 'new tab', 'blank', 'landing']
    },
    {
      title: 'Default Search Engine',
      description: 'Search engine used when typing non-URL text in the address bar.',
      keywords: [
        'browser',
        'search',
        'engine',
        'google',
        'duckduckgo',
        'bing',
        'kagi',
        'session',
        'private',
        'token',
        'omnibox',
        'query'
      ]
    },
    {
      title: 'Default Zoom',
      description: 'Zoom level applied to newly opened browser tabs.',
      keywords: ['browser', 'zoom', 'scale', 'default', 'page zoom', 'new tab', 'percentage']
    },
    {
      title: 'Link Routing',
      description: getBrowserLinkRoutingDescription(platform),
      keywords: [
        'browser',
        'preview',
        'links',
        'localhost',
        'webview',
        'shift',
        platform.isMac ? 'cmd' : 'ctrl',
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
}

export const BROWSER_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = getBrowserPaneSearchEntries()
