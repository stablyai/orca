import type { Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../../search/settings-search-keywords'

export type BrowserShortcutPlatform = {
  isMac: boolean
}

export function getTerminalLinkActionSearchKeywords(
  platform: BrowserShortcutPlatform,
  t?: Translate
): string[] {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return [
    ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
    ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.terminalLinkActions.terminal',
      'terminal'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.browser.search.terminalLinkActions.chat',
      'chat'
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
    'link click behavior',
    'open directly',
    'modifier-click only',
    'middle click',
    'mouse 3',
    platform.isMac ? 'cmd' : 'ctrl'
  ]
}
