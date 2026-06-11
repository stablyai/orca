import { AzureDevOpsIntegrationCard } from './azure-devops-integration-card'
import { BitbucketIntegrationCard } from './bitbucket-integration-card'
import { GiteaIntegrationCard } from './gitea-integration-card'
import type { AzureDevOpsStatus, BitbucketStatus, GiteaStatus } from './integrations-pane-status'

type EnvironmentTokenIntegrationCardsProps = {
  bitbucketStatus: BitbucketStatus
  bitbucketAccount: string | null
  azureDevOpsStatus: AzureDevOpsStatus
  azureDevOpsAccount: string | null
  azureDevOpsBaseUrl: string | null
  giteaStatus: GiteaStatus
  giteaAccount: string | null
  giteaBaseUrl: string | null
  onRefreshBitbucket: () => void
  onRefreshAzureDevOps: () => void
  onRefreshGitea: () => void
}

export function EnvironmentTokenIntegrationCards({
  bitbucketStatus,
  bitbucketAccount,
  azureDevOpsStatus,
  azureDevOpsAccount,
  azureDevOpsBaseUrl,
  giteaStatus,
  giteaAccount,
  giteaBaseUrl,
  onRefreshBitbucket,
  onRefreshAzureDevOps,
  onRefreshGitea
}: EnvironmentTokenIntegrationCardsProps): React.JSX.Element {
  return (
    <>
      <BitbucketIntegrationCard
        bitbucketStatus={bitbucketStatus}
        bitbucketAccount={bitbucketAccount}
        onRefreshBitbucket={onRefreshBitbucket}
      />
      <AzureDevOpsIntegrationCard
        azureDevOpsStatus={azureDevOpsStatus}
        azureDevOpsAccount={azureDevOpsAccount}
        azureDevOpsBaseUrl={azureDevOpsBaseUrl}
        onRefreshAzureDevOps={onRefreshAzureDevOps}
      />
      <GiteaIntegrationCard
        giteaStatus={giteaStatus}
        giteaAccount={giteaAccount}
        giteaBaseUrl={giteaBaseUrl}
        onRefreshGitea={onRefreshGitea}
      />
    </>
  )
}
