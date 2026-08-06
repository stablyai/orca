import type { Tab, TerminalTab } from './types'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'

export function resolveTerminalTabTitle(
  tab: Pick<TerminalTab, 'customTitle' | 'quickCommandLabel' | 'generatedTitle' | 'title'>,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveTitle = tab.title?.trim() ?? ''
  // Why: with session titles on, never fall through to live OSC — that switches
  // the tab between session name and working/status frames (#11075).
  if (generatedTitlesEnabled) {
    return (
      tab.customTitle?.trim() ||
      tab.quickCommandLabel?.trim() ||
      (isMeaningfulOpenCodeTerminalTitle(liveTitle) ? liveTitle : '') ||
      tab.generatedTitle?.trim() ||
      ''
    )
  }
  return tab.customTitle?.trim() || tab.quickCommandLabel?.trim() || liveTitle || fallback
}

export function resolveUnifiedTabLabel(
  tab: Pick<Tab, 'customLabel' | 'quickCommandLabel' | 'generatedLabel' | 'label'> | undefined,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveLabel = tab?.label?.trim() ?? ''
  if (generatedTitlesEnabled) {
    return (
      tab?.customLabel?.trim() ||
      tab?.quickCommandLabel?.trim() ||
      (isMeaningfulOpenCodeTerminalTitle(liveLabel) ? liveLabel : '') ||
      tab?.generatedLabel?.trim() ||
      ''
    )
  }
  return tab?.customLabel?.trim() || tab?.quickCommandLabel?.trim() || liveLabel || fallback
}
