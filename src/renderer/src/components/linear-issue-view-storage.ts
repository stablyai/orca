import {
  normalizeLinearIssueViewResumeState,
  resolveLinearIssueViewResumeState,
  type LinearIssueViewResumeState
} from '../../../shared/linear-issue-view-resume-state'

// Why: issue-list layout is a per-device view preference, not host state. Routing it
// through `ui.set` put it inside a strict nested schema, where a host that predates
// the field silently discarded the WHOLE taskResumeState — github and jira included.
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
    // Normalization returns undefined for an all-defaults view, so resetting the
    // list clears the key instead of pinning today's defaults against a future change.
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
