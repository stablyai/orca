import type { AiVaultSessionTitle } from './ai-vault/contracts/ai-vault-session-title'
import type { Tab } from './tab-types'
import type { TerminalTab } from './workspace-layout/terminal-tab-types'
import { isMeaningfulOpenCodeTerminalTitle } from './agent-status/title/providers/opencode-terminal-title'

export type TabNameSources = {
  /** A name the user typed into the tab. */
  customTitle?: string | null
  quickCommandLabel?: string | null
  /** The program's own terminal title right now. */
  liveTitle: string
  /** The agent session's title, already checked to belong to this tab's session. */
  sessionTitle?: Pick<AiVaultSessionTitle, 'title' | 'kind'> | null
  generatedTitle?: string | null
}

/** The one name order every tab and agent-row surface uses; '' leaves the plain live title to the caller. */
export function resolveTabNameSource(
  sources: TabNameSources,
  generatedTitlesEnabled: boolean
): string {
  const sessionTitle = sources.sessionTitle?.title.trim() ?? ''
  // Why: a quick-command label only names the tab until the session has a name of its own (a rename or
  // a provider-generated name); a first-prompt stand-in does not replace it. A typed tab name wins over both.
  const sessionNamed = sources.sessionTitle?.kind === 'named'
  return (
    sources.customTitle?.trim() ||
    (isMeaningfulOpenCodeTerminalTitle(sources.liveTitle) ? sources.liveTitle : '') ||
    (sessionNamed ? sessionTitle : '') ||
    sources.quickCommandLabel?.trim() ||
    sessionTitle ||
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
        sessionTitle: tab.aiVaultTitle,
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
        sessionTitle: tab?.aiVaultTitle,
        generatedTitle: tab?.generatedLabel
      },
      generatedTitlesEnabled
    ) ||
    liveLabel ||
    fallback
  )
}
