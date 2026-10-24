import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getBrowserLinkRoutingShortcutLabel(platform: { isMac: boolean }): string {
  return platform.isMac ? '⇧⌘-click' : 'Shift+Ctrl+click'
}

// Why: "always" stops being true once inverting is on, so only then does the nested
// row take over the chord sentence — with it off this reads exactly as it always has.
// Each variant is a complete catalog entry: stitched suffixes break in locales whose
// sentence joining differs from English.
export function getBrowserLinkRoutingDescription(
  platform: { isMac: boolean },
  modifierInverts = false
): string {
  if (modifierInverts) {
    return translate(
      'auto.components.settings.BrowserLinkRoutingSetting.descriptionBase',
      "Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor."
    )
  }
  return translate(
    'auto.components.settings.BrowserLinkRoutingSetting.description',
    "Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor. {{shortcut}} always uses your system browser.",
    { shortcut: getBrowserLinkRoutingShortcutLabel(platform) }
  )
}

/**
 * Title and description both name the destination the modifier reaches, which is
 * the opposite of wherever Link Routing points. Kept out of the component so the
 * settings-search index can reuse the same strings; the index pins openLinksInApp
 * to false, so it also indexes the other title as a keyword.
 */
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

// Why: the Orca branch is enabled-state copy — with the toggle off the chord
// still lands on the system browser, so it must not promise Orca in present tense.
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
