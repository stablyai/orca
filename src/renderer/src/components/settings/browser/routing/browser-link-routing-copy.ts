import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsSearchEntry } from '../../search/settings-search'
import { translateSearchKeyword } from '../../search/settings-search-keywords'

export function getBrowserLinkRoutingShortcutLabel(platform: { isMac: boolean }): string {
  return platform.isMac ? '⇧⌘-click' : 'Shift+Ctrl+click'
}

// Modifier inversion changes always-copy; use complete localized variants because sentence suffixes cannot be safely stitched across locales.
export function getBrowserLinkRoutingDescription(
  platform: { isMac: boolean },
  modifierInverts = false,
  t: Translate = translate
): string {
  if (modifierInverts) {
    return t(
      'auto.components.settings.BrowserLinkRoutingSetting.descriptionBase',
      'Open http(s) links from anywhere in Orca in its built-in browser. Sign-in pages still open in your system browser.'
    )
  }
  return t(
    'auto.components.settings.BrowserLinkRoutingSetting.description',
    'Open http(s) links from anywhere in Orca in its built-in browser. Sign-in pages and {{shortcut}} always use your system browser.',
    { shortcut: getBrowserLinkRoutingShortcutLabel(platform) }
  )
}

/** Share destination copy with search, which indexes the alternate title because its routing mode is fixed to false. */
export function getLinkRoutingModifierTitle(
  openLinksInApp: boolean,
  t: Translate = translate
): string {
  return openLinksInApp
    ? t(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.titleSystem',
        'Hold Shift to open in your web browser'
      )
    : t(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.titleOrca',
        'Hold Shift to open in Orca'
      )
}

// Orca describes enabled inversion; while disabled the chord still opens the system browser.
export function getLinkRoutingModifierDescription(
  {
    openLinksInApp,
    isMac
  }: {
    openLinksInApp: boolean
    isMac: boolean
  },
  t: Translate = translate
): string {
  const chord = isMac ? '⇧⌘' : 'Shift+Ctrl'
  return openLinksInApp
    ? t(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionSystem',
        'Links open in Orca, so {{chord}}+click sends one to your system browser instead.',
        { chord }
      )
    : t(
        'auto.components.settings.BrowserLinkRoutingModifierSetting.descriptionOrca',
        "Links open in your system browser. When enabled, {{chord}}+click opens one in Orca's built-in browser instead.",
        { chord }
      )
}

function getLinkRoutingBackgroundTitle(t: Translate = translate): string {
  return t(
    'auto.components.settings.BrowserLinkRoutingBackgroundSetting.title',
    'Open links in the background'
  )
}

function getLinkRoutingBackgroundDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.BrowserLinkRoutingBackgroundSetting.description',
    'Links from the terminal, chat, and markdown join the browser without taking focus from where you clicked.'
  )
}

export function getLinkRoutingBackgroundSearchEntry(t?: Translate): SettingsSearchEntry {
  return {
    title: getLinkRoutingBackgroundTitle(t),
    description: getLinkRoutingBackgroundDescription(t),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.2d2d995c58',
        'browser',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.bea27bac4b',
        'links',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.background',
        'background',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.focus',
        'focus',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.tab',
        'tab',
        undefined,
        t
      )
    ]
  }
}

function getLinkRoutingSplitTitle(t: Translate = translate): string {
  return t('auto.components.settings.BrowserLinkRoutingSplitSetting.title', 'Open links in a split')
}

function getLinkRoutingSplitDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.BrowserLinkRoutingSplitSetting.description',
    'With no browser visible, a link opens in a new pane beside the one you clicked. When off, it opens as a new tab in that pane.'
  )
}

export function getLinkRoutingSplitSearchEntry(t?: Translate): SettingsSearchEntry {
  return {
    title: getLinkRoutingSplitTitle(t),
    description: getLinkRoutingSplitDescription(t),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.2d2d995c58',
        'browser',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.bea27bac4b',
        'links',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingSplit.split',
        'split',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingSplit.pane',
        'pane',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.tab',
        'tab',
        undefined,
        t
      )
    ]
  }
}
