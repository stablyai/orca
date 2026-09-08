import type { TaskProvider } from '../../../shared/task-providers'
import type { TaskProviderIdentity } from '../../../shared/task-provider-identity'

// Extracted so adding a task provider touches one switch per concern instead of
// the same switch copied into the automations and task-source surfaces.

export function getTaskProviderLabel(provider: TaskProvider): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'linear':
      return 'Linear'
    case 'jira':
      return 'Jira'
    case 'plane':
      return 'Plane'
  }
}

/** The account or repository a stored source context points at. */
export function getTaskProviderIdentityLabel(
  identity: TaskProviderIdentity | null | undefined
): string | null {
  if (!identity) {
    return null
  }
  switch (identity.provider) {
    case 'github':
      return `${identity.owner}/${identity.repo}`
    case 'gitlab':
      return identity.namespace && identity.project
        ? `${identity.namespace}/${identity.project}`
        : (identity.projectId ?? null)
    case 'linear':
      return identity.workspaceName ?? identity.workspaceId ?? null
    case 'jira':
      return identity.siteUrl ?? identity.siteId ?? null
    case 'plane':
      return identity.workspaceSlug ?? identity.workspaceId ?? null
  }
}
