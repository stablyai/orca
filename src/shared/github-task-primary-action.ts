export const GITHUB_TASK_PRIMARY_ACTIONS = ['start', 'open-in-browser'] as const

export type GitHubTaskPrimaryAction = (typeof GITHUB_TASK_PRIMARY_ACTIONS)[number]

export const DEFAULT_GITHUB_TASK_PRIMARY_ACTION: GitHubTaskPrimaryAction = 'start'

export function isGitHubTaskPrimaryAction(value: unknown): value is GitHubTaskPrimaryAction {
  return value === 'start' || value === 'open-in-browser'
}

export function normalizeGitHubTaskPrimaryAction(value: unknown): GitHubTaskPrimaryAction {
  return value === 'open-in-browser' ? 'open-in-browser' : DEFAULT_GITHUB_TASK_PRIMARY_ACTION
}

export function resolveGitHubTaskSplitActions(preferred: unknown): {
  primary: GitHubTaskPrimaryAction
  menu: GitHubTaskPrimaryAction[]
} {
  const primary = normalizeGitHubTaskPrimaryAction(preferred)
  return {
    primary,
    menu: [primary === 'open-in-browser' ? 'start' : 'open-in-browser']
  }
}
