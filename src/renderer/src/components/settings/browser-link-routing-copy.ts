import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getBrowserLinkRoutingShortcutLabel(platform: { isMac: boolean }): string {
  return platform.isMac ? '⇧⌘-click' : 'Shift+Ctrl+click'
}

// Modifier inversion changes always-copy; use complete localized variants because sentence suffixes cannot be safely stitched across locales.
export function getBrowserLinkRoutingDescription(
  platform: { isMac: boolean },
  modifierInverts = false
): string {
  if (modifierInverts) {
    return translate(
      'auto.components.settings.BrowserLinkRoutingSetting.descriptionBase',
      'Open http(s) links from anywhere in Orca in its built-in browser. Sign-in pages still open in your system browser.'
    )
  }
  return translate(
    'auto.components.settings.BrowserLinkRoutingSetting.description',
    'Open http(s) links from anywhere in Orca in its built-in browser. Sign-in pages and {{shortcut}} always use your system browser.',
    { shortcut: getBrowserLinkRoutingShortcutLabel(platform) }
  )
}

/** Share destination copy with search, which indexes the alternate title because its routing mode is fixed to false. */
export function getLinkRoutingModifierTitle(openLinksInApp: boolean): string {
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
  isMac
}: {
  openLinksInApp: boolean
  isMac: boolean
}): string {
  const chord = isMac ? '⇧⌘' : 'Shift+Ctrl'
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

/** Title, description and search keywords for the split-beside toggle, shared by the row and settings search. */
export function getLinkRoutingSplitBesideSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.BrowserLinkRoutingSplitBesideSetting.title',
      'Open links in a split beside the pane'
    ),
    description: translate(
      'auto.components.settings.BrowserLinkRoutingSplitBesideSetting.description',
      'When no browser is visible, links open in a new pane beside where you clicked. Turn off to open them as a tab in the same pane.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
      ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingSplitBeside.split',
        'split'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingSplitBeside.pane',
        'pane'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.linkRoutingBackground.tab',
        'tab'
      )
    ]
  }
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

/** Background then split-beside, matching their order in the Browser pane. */
export function getLinkRoutingPlacementSearchEntries(): SettingsSearchEntry[] {
  return [getLinkRoutingBackgroundSearchEntry(), getLinkRoutingSplitBesideSearchEntry()]
}
