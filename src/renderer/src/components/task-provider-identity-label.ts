import type { TaskProviderIdentity } from '../../../shared/task-source-context'

export function getProviderIdentityLabel(
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
    case 'gitea':
      return identity.owner && identity.repo
        ? `${identity.owner}/${identity.repo}`
        : (identity.baseUrl ?? null)
  }
}
