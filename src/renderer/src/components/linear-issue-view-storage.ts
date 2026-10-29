import {
  normalizeLinearIssueViewResumeState,
  resolveLinearIssueViewResumeState,
  type LinearIssueViewResumeState
} from '../../../shared/linear/issue-view-resume-state'

// Keep per-device layout local; older hosts’ strict ui.set schemas can discard all taskResumeState when this field is unknown.
const STORAGE_KEY = 'orca.linear.issue-view.v1'

export function loadLinearIssueView(): LinearIssueViewResumeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return resolveLinearIssueViewResumeState(raw ? (JSON.parse(raw) as unknown) : undefined)
  } catch {
    return resolveLinearIssueViewResumeState(undefined)
  }
}

export function saveLinearIssueView(view: LinearIssueViewResumeState): void {
  try {
    // Remove all-default state so today’s defaults cannot override future default changes.
    const normalized = normalizeLinearIssueViewResumeState(view)
    if (!normalized) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // The live view stays usable when browser storage is unavailable or full.
  }
}
