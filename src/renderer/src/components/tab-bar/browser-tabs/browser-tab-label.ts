import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/browser/browser-blank-page'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { translate } from '../../../i18n/i18n'
import type { Translate } from '../../../i18n/use-translate'

export function formatBrowserTabUrlLabel(url: string, t: Translate = translate): string {
  if (url === ORCA_BROWSER_BLANK_URL || url === 'about:blank') {
    return t('auto.components.browser.pane.BrowserPane.366bf5d62c', 'New Tab')
  }
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

export function getBrowserTabLabel(tab: BrowserWorkspace, t?: Translate): string {
  if (
    !tab.title ||
    tab.title === tab.url ||
    tab.title === ORCA_BROWSER_BLANK_URL ||
    tab.title === 'about:blank'
  ) {
    return formatBrowserTabUrlLabel(tab.url, t)
  }
  return tab.title || tab.url
}
