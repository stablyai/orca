import type { Tab } from './tab-types'
import type { TerminalTab } from './workspace-layout/terminal-tab-types'
import { isMeaningfulOpenCodeTerminalTitle } from './agent-status/title/providers/opencode-terminal-title'

export type TabNameSources = {
  /** A name the user typed into the tab. */
  customTitle?: string | null
  quickCommandLabel?: string | null
  /** The program's own terminal title right now. */
  liveTitle: string
  /** The agent session's own name, already checked to belong to this tab's session. */
  sessionTitle?: string | null
  generatedTitle?: string | null
}

/** The one name order every tab and agent-row surface uses; '' leaves the plain live title to the caller. */
export function resolveTabNameSource(
  sources: TabNameSources,
  generatedTitlesEnabled: boolean
): string {
  return (
    sources.customTitle?.trim() ||
    sources.quickCommandLabel?.trim() ||
    (isMeaningfulOpenCodeTerminalTitle(sources.liveTitle) ? sources.liveTitle : '') ||
    sources.sessionTitle?.trim() ||
    (generatedTitlesEnabled ? sources.generatedTitle?.trim() : '') ||
    ''
  )
}

export function resolveTerminalTabTitle(
  tab: Pick<TerminalTab, 'quickCommandLabel' | 'aiVaultTitle' | 'generatedTitle' | 'title'> & {
    customTitle?: string | null
  },
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveTitle = tab.title?.trim() ?? ''
  return (
    resolveTabNameSource(
      {
        customTitle: tab.customTitle,
        quickCommandLabel: tab.quickCommandLabel,
        liveTitle,
        sessionTitle: tab.aiVaultTitle?.title,
        generatedTitle: tab.generatedTitle
      },
      generatedTitlesEnabled
    ) ||
    liveTitle ||
    fallback
  )
}

export function resolveUnifiedTabLabel(
  tab:
    | Pick<Tab, 'customLabel' | 'quickCommandLabel' | 'aiVaultTitle' | 'generatedLabel' | 'label'>
    | undefined,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveLabel = tab?.label?.trim() ?? ''
  return (
    resolveTabNameSource(
      {
        customTitle: tab?.customLabel,
        quickCommandLabel: tab?.quickCommandLabel,
        liveTitle: liveLabel,
        sessionTitle: tab?.aiVaultTitle?.title,
        generatedTitle: tab?.generatedLabel
      },
      generatedTitlesEnabled
    ) ||
    liveLabel ||
    fallback
  )
}
