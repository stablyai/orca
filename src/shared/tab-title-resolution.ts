import type { Tab, TerminalTab } from './types'

export function resolveTerminalTabTitle(
  tab: Pick<TerminalTab, 'customTitle' | 'quickCommandLabel' | 'generatedTitle' | 'title'>,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  return (
    tab.customTitle?.trim() ||
    tab.quickCommandLabel?.trim() ||
    (generatedTitlesEnabled ? tab.generatedTitle?.trim() : '') ||
    tab.title?.trim() ||
    fallback
  )
}

export function resolveUnifiedTabLabel(
  tab: Pick<Tab, 'customLabel' | 'quickCommandLabel' | 'generatedLabel' | 'label'> | undefined,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  return (
    tab?.customLabel?.trim() ||
    tab?.quickCommandLabel?.trim() ||
    (generatedTitlesEnabled ? tab?.generatedLabel?.trim() : '') ||
    tab?.label?.trim() ||
    fallback
  )
}
