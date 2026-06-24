import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type AutomationSourceDisplay = {
  label: string
  title: string
}

export function getAutomationSourceDisplay(
  sourceContext: TaskSourceContext | null | undefined,
  hostLabelById?: ReadonlyMap<string, string>
): AutomationSourceDisplay | null {
  if (!sourceContext) {
    return null
  }
  const providerLabel = getProviderLabel(sourceContext.provider)
  const hostLabel =
    hostLabelById?.get(sourceContext.hostId) ?? getExecutionHostLabel(sourceContext.hostId)
  const identityLabel = getSourceIdentityLabel(sourceContext)
  const label = [providerLabel, hostLabel, identityLabel]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  const title = [
    `${providerLabel} source`,
    `Host: ${hostLabel}`,
    sourceContext.accountLabel ? `Account: ${sourceContext.accountLabel}` : null,
    identityLabel ? `Source: ${identityLabel}` : null
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  return { label, title }
}

function getProviderLabel(provider: TaskSourceContext['provider']): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'gitea':
      return 'Gitea'
    case 'linear':
      return 'Linear'
    case 'jira':
      return 'Jira'
  }
}

function getSourceIdentityLabel(sourceContext: TaskSourceContext): string | null {
  const identity = sourceContext.providerIdentity
  if (identity) {
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
  return sourceContext.accountLabel ?? sourceContext.repoId ?? null
}
