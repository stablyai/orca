import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getBrowserLinkRoutingShortcutLabel(platform: { isMac: boolean }): string {
  return platform.isMac ? '⇧⌘-click' : 'Shift+Ctrl+click'
}

// Modifier inversion changes always-copy; use complete localized variants because sentence suffixes cannot be safely stitched across locales.
export function getBrowserLinkRoutingDescription(
  platform: { isMac: boolean },
  modifierInverts = false,
  externalBrowserName: string | null = null
): string {
  if (modifierInverts) {
    return translate(
      'auto.components.settings.BrowserLinkRoutingSetting.descriptionBase',
      "Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor."
    )
  }
  if (externalBrowserName) {
    return translate(
      'auto.components.settings.BrowserLinkRoutingSetting.descriptionNamedBrowser',
      "Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor. {{shortcut}} always uses {{browser}}.",
      { shortcut: getBrowserLinkRoutingShortcutLabel(platform), browser: externalBrowserName }
    )
  }
  return translate(
    'auto.components.settings.BrowserLinkRoutingSetting.description',
    "Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor. {{shortcut}} always uses your system browser.",
    { shortcut: getBrowserLinkRoutingShortcutLabel(platform) }
  )
}

/** Share destination copy with search, which indexes the alternate title because its routing mode is fixed to false. */
export function getLinkRoutingModifierTitle(
  openLinksInApp: boolean,
  externalBrowserName: string | null = null
): string {
  if (openLinksInApp && externalBrowserName) {
    return translate(
      'auto.components.settings.BrowserLinkRoutingModifierSetting.titleNamedBrowser',
      'Hold Shift to open in {{browser}}',
      { browser: externalBrowserName }
    )
  }
  return openLinksInApp
    ? translate(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.titleSystem',
        'Hold Shift to open in your web browser'
      )
    : translate(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.titleOrca',
        'Hold Shift to open in Orca'
      )
}

// Orca describes enabled inversion; while disabled the chord still opens the system browser.
export function getLinkRoutingModifierDescription({
  openLinksInApp,
  isMac,
  externalBrowserName = null
}: {
  openLinksInApp: boolean
  isMac: boolean
  externalBrowserName?: string | null
}): string {
  const chord = isMac ? '⇧⌘' : 'Shift+Ctrl'
  if (externalBrowserName) {
    return openLinksInApp
      ? translate(
          'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionNamedBrowserFromOrca',
          'Links open in Orca, so {{chord}}+click sends one to {{browser}} instead.',
          { chord, browser: externalBrowserName }
        )
      : translate(
          'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionOrcaFromNamedBrowser',
          "Links open in {{browser}}. When enabled, {{chord}}+click opens one in Orca's built-in browser instead.",
          { chord, browser: externalBrowserName }
        )
  }
  return openLinksInApp
    ? translate(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionSystem',
        'Links open in Orca, so {{chord}}+click sends one to your system browser instead.',
        { chord }
      )
    : translate(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionOrca',
        "Links open in your system browser. When enabled, {{chord}}+click opens one in Orca's built-in browser instead.",
        { chord }
      )
}

export function getLinkRoutingSearchEntry(platform: { isMac: boolean }): SettingsSearchEntry {
  return {
    title: translate('auto.components.settings.browser.search.5cb082b3e3', 'Link Routing'),
    description: getBrowserLinkRoutingDescription(platform),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
      ...translateSearchKeyword('auto.components.settings.browser.search.44d14df30d', 'preview'),
      ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
      ...translateSearchKeyword('auto.components.settings.browser.search.82ba1c80ea', 'localhost'),
      ...translateSearchKeyword('auto.components.settings.browser.search.72c58f7792', 'webview'),
      ...translateSearchKeyword('auto.components.settings.browser.search.90425d313c', 'shift'),
      platform.isMac ? 'cmd' : 'ctrl',
      ...translateSearchKeyword('auto.components.settings.browser.search.68d1db8929', 'markdown'),
      ...translateSearchKeyword('auto.components.settings.browser.search.8dd4805991', 'file'),
      ...translateSearchKeyword('auto.components.settings.browser.search.a7a07d5415', 'editor'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRouting.defaultBrowser',
        'default browser'
      ),
      ...translateSearchKeyword('auto.components.settings.browser.search.75a0d435b7', 'chrome'),
      ...translateSearchKeyword('auto.components.settings.browser.search.533a253deb', 'edge'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRouting.firefox',
        'firefox'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRouting.safari',
        'safari'
      )
    ]
  }
}

function getLinkRoutingBackgroundTitle(): string {
  return translate(
    'auto.components.settings.BrowserLinkRoutingBackgroundSetting.title',
    'Open links in the background'
  )
}

function getLinkRoutingBackgroundDescription(): string {
  return translate(
    'auto.components.settings.BrowserLinkRoutingBackgroundSetting.description',
    'Links from the terminal, chat, and markdown join the browser without taking focus from where you clicked.'
  )
}

export function getLinkRoutingBackgroundSearchEntry(): SettingsSearchEntry {
  return {
    title: getLinkRoutingBackgroundTitle(),
    description: getLinkRoutingBackgroundDescription(),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
      ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.background',
        'background'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.focus',
        'focus'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.tab',
        'tab'
      )
    ]
  }
}
