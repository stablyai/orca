import type { Tab, TerminalTab } from './types'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'

/** The owning session's (worktree's) name, used to fill in a tab title when the
 *  tab has no title of its own. `branchName` lets us tell a name the user
 *  actually typed from the auto default that still matches the branch. */
export type TabSessionNameFallback = {
  displayName?: string | null
  branchName?: string | null
}

// Why: only a name the user actually changed should stand in for a tab title; a
// display name still equal to the branch is the auto default and must not
// override every tab's own live/generated title.
function resolveRenamedSessionName(sessionName?: TabSessionNameFallback): string {
  const displayName = sessionName?.displayName?.trim()
  if (!displayName) {
    return ''
  }
  return displayName === sessionName?.branchName?.trim() ? '' : displayName
}

export function resolveTerminalTabTitle(
  tab: Pick<TerminalTab, 'customTitle' | 'quickCommandLabel' | 'generatedTitle' | 'title'>,
  generatedTitlesEnabled: boolean,
  fallback = '',
  sessionName?: TabSessionNameFallback
): string {
  const liveTitle = tab.title?.trim() ?? ''
  return (
    tab.customTitle?.trim() ||
    tab.quickCommandLabel?.trim() ||
    (isMeaningfulOpenCodeTerminalTitle(liveTitle) ? liveTitle : '') ||
    (generatedTitlesEnabled ? tab.generatedTitle?.trim() : '') ||
    resolveRenamedSessionName(sessionName) ||
    liveTitle ||
    fallback
  )
}

export function resolveUnifiedTabLabel(
  tab: Pick<Tab, 'customLabel' | 'quickCommandLabel' | 'generatedLabel' | 'label'> | undefined,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveLabel = tab?.label?.trim() ?? ''
  return (
    tab?.customLabel?.trim() ||
    tab?.quickCommandLabel?.trim() ||
    (isMeaningfulOpenCodeTerminalTitle(liveLabel) ? liveLabel : '') ||
    (generatedTitlesEnabled ? tab?.generatedLabel?.trim() : '') ||
    liveLabel ||
    fallback
  )
}
