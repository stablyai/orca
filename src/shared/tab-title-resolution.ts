import type { Tab, TerminalTab } from './types'
import { isAgentRenamedTerminalTitle } from './agent-session-rename-title'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'

export function resolveTerminalTabTitle(
  tab: Pick<
    TerminalTab,
    'customTitle' | 'quickCommandLabel' | 'generatedTitle' | 'title' | 'agentRenamedTitle'
  >,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveTitle = tab.title?.trim() ?? ''
  return (
    tab.customTitle?.trim() ||
    tab.quickCommandLabel?.trim() ||
    (isAgentRenamedTerminalTitle(liveTitle, tab.agentRenamedTitle) ? liveTitle : '') ||
    (isMeaningfulOpenCodeTerminalTitle(liveTitle) ? liveTitle : '') ||
    (generatedTitlesEnabled ? tab.generatedTitle?.trim() : '') ||
    liveTitle ||
    fallback
  )
}

export function resolveUnifiedTabLabel(
  tab:
    | Pick<
        Tab,
        'customLabel' | 'quickCommandLabel' | 'generatedLabel' | 'label' | 'agentRenamedLabel'
      >
    | undefined,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveLabel = tab?.label?.trim() ?? ''
  return (
    tab?.customLabel?.trim() ||
    tab?.quickCommandLabel?.trim() ||
    (isAgentRenamedTerminalTitle(liveLabel, tab?.agentRenamedLabel) ? liveLabel : '') ||
    (isMeaningfulOpenCodeTerminalTitle(liveLabel) ? liveLabel : '') ||
    (generatedTitlesEnabled ? tab?.generatedLabel?.trim() : '') ||
    liveLabel ||
    fallback
  )
}
