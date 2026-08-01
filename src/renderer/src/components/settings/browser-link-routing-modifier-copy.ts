import { translate } from '@/i18n/i18n'

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
