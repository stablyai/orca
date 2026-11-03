import type { TaskProvider } from '../../../shared/task-providers'
import type { TaskProviderIdentity } from '../../../shared/task-provider-identity'

export function getTaskSourceProviderLabel(provider: TaskProvider): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'linear':
      return 'Linear'
    case 'jira':
      return 'Jira'
    case 'clickup':
      return 'ClickUp'
  }
}

/** The most specific thing a stored identity names: repo, project, team, site, or List. */
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
    case 'clickup':
      return identity.listName ?? identity.listId ?? identity.workspaceName ?? null
  }
}
