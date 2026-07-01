import type { Tab, TerminalTab } from './types'
import type { TerminalTabTitleSource } from './terminal-tab-title-reducer'

export function resolveTerminalTabTitle(
  tab: Pick<
    TerminalTab,
    'customTitle' | 'quickCommandLabel' | 'generatedTitle' | 'title' | 'titleSource'
  >,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const authoritativeTitle = resolveAuthoritativeTitle(tab.title, tab.titleSource)
  return (
    tab.customTitle?.trim() ||
    authoritativeTitle ||
    tab.quickCommandLabel?.trim() ||
    (generatedTitlesEnabled ? tab.generatedTitle?.trim() : '') ||
    tab.title?.trim() ||
    fallback
  )
}

export function resolveUnifiedTabLabel(
  tab:
    | Pick<Tab, 'customLabel' | 'quickCommandLabel' | 'generatedLabel' | 'label' | 'labelSource'>
    | undefined,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const authoritativeLabel = resolveAuthoritativeTitle(tab?.label, tab?.labelSource)
  return (
    tab?.customLabel?.trim() ||
    authoritativeLabel ||
    tab?.quickCommandLabel?.trim() ||
    (generatedTitlesEnabled ? tab?.generatedLabel?.trim() : '') ||
    tab?.label?.trim() ||
    fallback
  )
}

function resolveAuthoritativeTitle(
  title: string | null | undefined,
  source: TerminalTabTitleSource | null | undefined
): string {
  return source === 'authoritative-tab' ? title?.trim() || '' : ''
}
