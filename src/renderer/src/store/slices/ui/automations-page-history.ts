import { appendHistoryEntry, type WorktreeNavHistoryEntry } from './workspace-navigation-history'
import type { AutomationsPageLocation } from './automations-page-location'

type HistoryState = {
  worktreeNavHistory: WorktreeNavHistoryEntry[]
  worktreeNavHistoryIndex: number
}

/**
 * Record an Automations sub-page. The plain 'automations' sentinel that opening the page
 * recorded is replaced in place, so Back never lands on a duplicate of the same page.
 */
export function appendAutomationsPageEntry(
  s: HistoryState,
  location: AutomationsPageLocation
): HistoryState {
  const entry: WorktreeNavHistoryEntry = { kind: 'automations-page', location }
  if (s.worktreeNavHistory[s.worktreeNavHistoryIndex] !== 'automations') {
    return appendHistoryEntry(s, entry)
  }
  const next = s.worktreeNavHistory.slice(0, s.worktreeNavHistoryIndex + 1)
  next[s.worktreeNavHistoryIndex] = entry
  return { worktreeNavHistory: next, worktreeNavHistoryIndex: s.worktreeNavHistoryIndex }
}
