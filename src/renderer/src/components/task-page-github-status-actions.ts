import type {
  GitHubIssueCloseReason,
  GitHubIssueUpdate,
  GitHubWorkItem
} from '../../../shared/types'

export type TaskPageGitHubCloseAction =
  | { stateReason: Exclude<GitHubIssueCloseReason, 'duplicate'> }
  | { stateReason: 'duplicate'; duplicateOf: number }

export type TaskPageGitHubDuplicateValidation =
  | { ok: true; duplicateOf: number }
  | {
      ok: false
      reason: 'missing' | 'not_integer' | 'not_positive' | 'same_issue'
    }

export type TaskPageGitHubDuplicateValidationError = Extract<
  TaskPageGitHubDuplicateValidation,
  { ok: false }
>

type TranslateDuplicateError = (key: string, fallback: string) => string

export function buildTaskPageGitHubCloseUpdate(
  action: TaskPageGitHubCloseAction
): GitHubIssueUpdate {
  return {
    state: 'closed',
    stateReason: action.stateReason,
    ...(action.stateReason === 'duplicate' ? { duplicateOf: action.duplicateOf } : {})
  }
}

export function validateTaskPageGitHubDuplicateTarget(
  value: string,
  currentIssueNumber: number
): TaskPageGitHubDuplicateValidation {
  const trimmed = value.trim()
  if (!trimmed) {
    return { ok: false, reason: 'missing' }
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: 'not_integer' }
  }
  const duplicateOf = Number(trimmed)
  if (!Number.isSafeInteger(duplicateOf) || duplicateOf <= 0) {
    return { ok: false, reason: 'not_positive' }
  }
  if (duplicateOf === currentIssueNumber) {
    return { ok: false, reason: 'same_issue' }
  }
  return { ok: true, duplicateOf }
}

export function getTaskPageGitHubDuplicateTargetErrorMessage(
  validation: TaskPageGitHubDuplicateValidationError,
  translate: TranslateDuplicateError
): string {
  switch (validation.reason) {
    case 'missing':
      return translate(
        'auto.components.TaskPage.duplicateIssueMissing',
        'Enter an issue number in this repository.'
      )
    case 'not_integer':
      return translate(
        'auto.components.TaskPage.duplicateIssueNotInteger',
        'Use a whole issue number.'
      )
    case 'not_positive':
      return translate(
        'auto.components.TaskPage.duplicateIssueNotPositive',
        'Use a positive issue number.'
      )
    case 'same_issue':
      return translate(
        'auto.components.TaskPage.duplicateIssueSameIssue',
        'Choose a different issue.'
      )
  }
}

export function getTaskPageGitHubDuplicateCandidates(
  items: GitHubWorkItem[],
  currentIssueNumber: number,
  query: string
): GitHubWorkItem[] {
  const normalizedQuery = query.trim().toLowerCase()
  return items.filter((candidate) => {
    if (candidate.type !== 'issue' || candidate.number === currentIssueNumber) {
      return false
    }
    if (!normalizedQuery) {
      return true
    }
    return (
      candidate.title.toLowerCase().includes(normalizedQuery) ||
      String(candidate.number).includes(normalizedQuery)
    )
  })
}
