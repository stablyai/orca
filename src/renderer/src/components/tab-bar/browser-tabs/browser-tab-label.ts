import { getBrowserDisplayTitle } from '../../../../../shared/browser/browser-display-title'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { translate } from '../../../i18n/i18n'
import type { Translate } from '../../../i18n/use-translate'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'

export function formatBrowserTabUrlLabel(url: string, t: Translate = translate): string {
  if (isBlankBrowserUrl(url)) {
    return t('auto.components.browser.pane.BrowserPane.366bf5d62c', 'New Tab')
  }
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

// Why: blank pages store getBrowserDisplayTitle's untranslated placeholder, which must be
// relabeled; doc previews also use the blank URL but carry a real file-name title.
function isBlankPagePlaceholderTitle(title: string, url: string): boolean {
  return isBlankBrowserUrl(url) && title === getBrowserDisplayTitle(null, url)
}

export function formatBrowserTabTitleLabel(title: string, url: string, t?: Translate): string {
  if (
    !title ||
    title === url ||
    isBlankBrowserUrl(title) ||
    isBlankPagePlaceholderTitle(title, url)
  ) {
    return formatBrowserTabUrlLabel(url, t)
  }
  return title
}

export function getBrowserTabLabel(tab: BrowserWorkspace, t?: Translate): string {
  return formatBrowserTabTitleLabel(tab.title, tab.url, t)
}
