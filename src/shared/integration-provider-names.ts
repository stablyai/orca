import type { HostedReviewProvider } from './hosted-review'
import type { TaskProvider } from './task-providers'

export type NamedIntegrationProvider = TaskProvider | Exclude<HostedReviewProvider, 'unsupported'>

// Why: brand names stay in Latin script in every locale, so these do not go through translate().
export const INTEGRATION_PROVIDER_NAMES = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira',
  bitbucket: 'Bitbucket',
  'azure-devops': 'Azure DevOps',
  gitea: 'Gitea'
} as const satisfies Record<NamedIntegrationProvider, string>

export type IntegrationProviderName<P extends NamedIntegrationProvider = NamedIntegrationProvider> =
  (typeof INTEGRATION_PROVIDER_NAMES)[P]
