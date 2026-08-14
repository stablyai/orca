import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

/**
 * Copy for the "Show terminal link actions" row. The catalog keys still say
 * `browser` because the row lived in the Browser pane before it moved here;
 * renaming them would drop the existing es/ja/ko/zh translations.
 */
export function getTerminalLinkActionsTitle(): string {
  return translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.title',
    'Show terminal link actions'
  )
}

export function getTerminalLinkActionsDescription(platform: { isMac: boolean }): string {
  return translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.description',
    'Show available actions when you click a terminal link. Turn this off to require {{modifier}}-click.',
    { modifier: platform.isMac ? '⌘' : 'Ctrl' }
  )
}

export function getTerminalLinkActionSearchKeywords(platform: { isMac: boolean }): string[] {
  return [
    ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
    ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.terminalLinkActions.terminal',
      'terminal'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.terminalLinkActions.click',
      'click'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.terminalLinkActions.actions',
      'actions'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.terminalLinkActions.popover',
      'popover'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.terminalLinkActions.menu',
      'menu'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.terminalLinkActions.disable',
      'disable'
    ),
    platform.isMac ? 'cmd' : 'ctrl'
  ]
}
