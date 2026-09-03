import type { WorkspaceLinkedTask } from './workspace-linked-task'

/** Provider names are brand names, so they stay untranslated. */
export const WORKSPACE_LINKED_TASK_PROVIDER_LABELS: Record<
  WorkspaceLinkedTask['provider'],
  string
> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira'
}
