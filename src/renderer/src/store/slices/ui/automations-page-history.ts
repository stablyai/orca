import { appendHistoryEntry, type WorktreeNavHistoryEntry } from './workspace-navigation-history'
import {
  automationsPageLocationKey,
  type AutomationsPageLocation,
  type AutomationsPageVisitMode
} from './automations-page-location'

type HistoryState = {
  worktreeNavHistory: WorktreeNavHistoryEntry[]
  worktreeNavHistoryIndex: number
}

function isPreviousEntry(s: HistoryState, location: AutomationsPageLocation): boolean {
  const previous = s.worktreeNavHistory[s.worktreeNavHistoryIndex - 1]
  return (
    typeof previous === 'object' &&
    previous.kind === 'automations-page' &&
    automationsPageLocationKey(previous.location) === automationsPageLocationKey(location)
  )
}

function replaceCurrentEntry(s: HistoryState, entry: WorktreeNavHistoryEntry): HistoryState {
  const next = s.worktreeNavHistory.slice()
  next[s.worktreeNavHistoryIndex] = entry
  return { worktreeNavHistory: next, worktreeNavHistoryIndex: s.worktreeNavHistoryIndex }
}

/**
 * Record an Automations sub-page. The plain 'automations' sentinel that opening the page
 * recorded is replaced in place, so Back never lands on a duplicate of the same page.
 * 'return' steps the index back when the destination is the previous entry (Escape to the
 * parent), so Forward still reaches the page that was left.
 */
export function appendAutomationsPageEntry(
  s: HistoryState,
  location: AutomationsPageLocation,
  mode: AutomationsPageVisitMode = 'push'
): HistoryState {
  const entry: WorktreeNavHistoryEntry = { kind: 'automations-page', location }
  const current = s.worktreeNavHistory[s.worktreeNavHistoryIndex]
  if (current === 'automations') {
    return replaceCurrentEntry(s, entry)
  }
  if (mode === 'return') {
    if (isPreviousEntry(s, location)) {
      const next = s.worktreeNavHistory.slice()
      next[s.worktreeNavHistoryIndex - 1] = entry
      return { worktreeNavHistory: next, worktreeNavHistoryIndex: s.worktreeNavHistoryIndex - 1 }
    }
  }
  return appendHistoryEntry(s, entry)
}
