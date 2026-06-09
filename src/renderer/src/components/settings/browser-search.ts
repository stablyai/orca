import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'

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
      title: translate('auto.components.settings.browser.search.c3903322d2', 'Default Home Page'),
      description: translate(
        'auto.components.settings.browser.search.a942905148',
        'URL opened when creating a new browser tab. Leave empty to open a blank tab.'
      ),
      keywords: [
        translate('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        translate('auto.components.settings.browser.search.291f480a5e', 'home'),
        translate('auto.components.settings.browser.search.0dbb1eaf4e', 'homepage'),
        translate('auto.components.settings.browser.search.5448f4097b', 'default'),
        translate('auto.components.settings.browser.search.4fda4fb066', 'url'),
        translate('auto.components.settings.browser.search.483a0eb5e0', 'new tab'),
        translate('auto.components.settings.browser.search.5164c47e31', 'blank'),
        translate('auto.components.settings.browser.search.4596a52cf7', 'landing')
      ]
    },
    {
      title: translate(
        'auto.components.settings.browser.search.5e755920c9',
        'Default Search Engine'
      ),
      description: translate(
        'auto.components.settings.browser.search.0628d5943b',
        'Search engine used when typing non-URL text in the address bar.'
      ),
      keywords: [
        translate('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        translate('auto.components.settings.browser.search.16bd69cd82', 'search'),
        translate('auto.components.settings.browser.search.72b4b89970', 'engine'),
        translate('auto.components.settings.browser.search.8a489aab8d', 'google'),
        translate('auto.components.settings.browser.search.1f8153acfb', 'duckduckgo'),
        translate('auto.components.settings.browser.search.ad40e75d13', 'bing'),
        translate('auto.components.settings.browser.search.e1c2a57f07', 'kagi'),
        translate('auto.components.settings.browser.search.66dd641a47', 'session'),
        translate('auto.components.settings.browser.search.0732ebe6fb', 'private'),
        translate('auto.components.settings.browser.search.3538b3aaeb', 'token'),
        translate('auto.components.settings.browser.search.8b8ed06e4b', 'omnibox'),
        translate('auto.components.settings.browser.search.0bb34eacc9', 'query')
      ]
    },
    {
      title: translate('auto.components.settings.browser.search.072b7f5c1f', 'Default Zoom'),
      description: translate(
        'auto.components.settings.browser.search.c3d89ed4d0',
        'Zoom level applied to newly opened browser tabs.'
      ),
      keywords: [
        translate('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        translate('auto.components.settings.browser.search.4a98ed195f', 'zoom'),
        translate('auto.components.settings.browser.search.54f4ea55f7', 'scale'),
        translate('auto.components.settings.browser.search.5448f4097b', 'default'),
        translate('auto.components.settings.browser.search.726f2a8556', 'page zoom'),
        translate('auto.components.settings.browser.search.483a0eb5e0', 'new tab'),
        translate('auto.components.settings.browser.search.95944898e0', 'percentage')
      ]
    },
    {
      title: translate('auto.components.settings.browser.search.5cb082b3e3', 'Link Routing'),
      description: getBrowserLinkRoutingDescription(platform),
      keywords: [
        translate('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        translate('auto.components.settings.browser.search.44d14df30d', 'preview'),
        translate('auto.components.settings.browser.search.bea27bac4b', 'links'),
        translate('auto.components.settings.browser.search.82ba1c80ea', 'localhost'),
        translate('auto.components.settings.browser.search.72c58f7792', 'webview'),
        translate('auto.components.settings.browser.search.90425d313c', 'shift'),
        platform.isMac ? 'cmd' : 'ctrl',
        translate('auto.components.settings.browser.search.68d1db8929', 'markdown'),
        translate('auto.components.settings.browser.search.8dd4805991', 'file'),
        translate('auto.components.settings.browser.search.a7a07d5415', 'editor')
      ]
    },
    {
      title: translate('auto.components.settings.browser.search.96afedcb5c', 'Session & Cookies'),
      description: translate(
        'auto.components.settings.browser.search.060ac1fcba',
        'Import cookies from Chrome, Edge, or other browsers to use existing logins inside Orca.'
      ),
      keywords: [
        translate('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        translate('auto.components.settings.browser.search.29193a51d5', 'cookies'),
        translate('auto.components.settings.browser.search.66dd641a47', 'session'),
        translate('auto.components.settings.browser.search.2e7f951773', 'import'),
        translate('auto.components.settings.browser.search.3910a41f32', 'auth'),
        translate('auto.components.settings.browser.search.854ef6ce83', 'login'),
        translate('auto.components.settings.browser.search.75a0d435b7', 'chrome'),
        translate('auto.components.settings.browser.search.533a253deb', 'edge'),
        translate('auto.components.settings.browser.search.1c1e097985', 'arc'),
        translate('auto.components.settings.browser.search.7539f6336c', 'profile')
      ]
    }
  ]
}
