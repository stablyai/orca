import type { TaskProviderIdentity } from '../../../shared/task-source-context'

// Why: extracted from task-source-context-summary.ts so that module stays under
// the max-lines budget as new providers (gitea) add identity cases. Pure helper —
// maps a provider identity to its display label.
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
    case 'gitea':
      return identity.owner && identity.repo ? `${identity.owner}/${identity.repo}` : null
    case 'linear':
      return identity.workspaceName ?? identity.workspaceId ?? null
    case 'jira':
      return identity.siteUrl ?? identity.siteId ?? null
  }
}
