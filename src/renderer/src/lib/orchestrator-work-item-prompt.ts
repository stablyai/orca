// Why: pure builders that turn a tracked issue into the director's name + task
// prompt. Kept free of store/UI imports so they're independently testable and
// reusable by any "Send to Orcastrator" entry point.

/** Provider-agnostic shape of a tracked issue being sent to a director. */
export type OrchestratorWorkItemInput = {
  /** Source tracker — metadata for now (the prompt/name derive from identifier
   *  or number), kept so future entry points can label or route by provider. */
  provider?: 'github' | 'gitlab' | 'linear' | 'jira'
  title: string
  url: string
  /** Tracker key for trackers that use one (Jira `KEY-12`, Linear `ENG-34`). */
  identifier?: string
  /** Issue/PR/MR number for numeric trackers (GitHub, GitLab). */
  number?: number | null
  /** Source repo when the issue is repo-bound (GitHub, GitLab) — used to
   *  pre-select the project; absent for cross-project trackers (Jira, Linear). */
  repoId?: string
}

function workItemRef(item: OrchestratorWorkItemInput): string | null {
  return item.identifier ?? (item.number != null ? `#${item.number}` : null)
}

/** Short, human label for the director (shown in the ORCASTRATORS list). */
export function buildWorkItemOrchestratorName(item: OrchestratorWorkItemInput): string {
  const ref = workItemRef(item)
  return ref ? `${ref} ${item.title}` : item.title
}

/** The task seeded after `/orcastrate` so the director starts planning the issue. */
export function buildWorkItemOrchestratorPrompt(item: OrchestratorWorkItemInput): string {
  const ref = workItemRef(item)
  const heading = ref ? `${ref}: ${item.title}` : item.title
  return [
    'Plan and deliver this tracked issue end to end: split it into worktrees/PRs as the work requires, then direct workers to implement, review, and land each one. Fetch the full issue details before planning.',
    '',
    heading,
    item.url
  ].join('\n')
}
