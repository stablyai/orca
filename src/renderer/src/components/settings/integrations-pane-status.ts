import type { PreflightStatus } from '../../../../preload/api-types'

export type GhStatus = 'checking' | 'connected' | 'not-installed' | 'not-authenticated'
// Why: parallel to GhStatus — GitLab uses glab and the same three failure
// modes (probe in-flight / installed-but-unauth / missing entirely).
export type GlabStatus = GhStatus
export type BitbucketStatus = 'checking' | 'connected' | 'not-configured' | 'not-authenticated'
export type AzureDevOpsStatus = 'checking' | 'configured' | 'not-configured' | 'not-authenticated'
export type GiteaStatus = 'checking' | 'configured' | 'not-configured' | 'not-authenticated'
export type PreflightRefreshProvider = 'gh' | 'glab' | 'bitbucket' | 'azureDevOps' | 'gitea'

export type PreflightIntegrationStatuses = {
  ghStatus: GhStatus
  glabStatus: GlabStatus
  bitbucketStatus: BitbucketStatus
  bitbucketAccount: string | null
  azureDevOpsStatus: AzureDevOpsStatus
  azureDevOpsAccount: string | null
  azureDevOpsBaseUrl: string | null
  giteaStatus: GiteaStatus
  giteaAccount: string | null
  giteaBaseUrl: string | null
}

type TokenApiPreflightStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  baseUrl: string | null
  tokenConfigured: boolean
}

type GiteaPreflightStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  baseUrl: string | null
  tokenConfigured: boolean
}

export function tokenApiStatusFromPreflight(
  status: TokenApiPreflightStatus | undefined
): AzureDevOpsStatus {
  if (!status?.configured) {
    return 'not-configured'
  }
  if (status.tokenConfigured && !status.baseUrl) {
    return 'configured'
  }
  if (status.tokenConfigured && !status.authenticated) {
    return 'not-authenticated'
  }
  return 'configured'
}

export function giteaStatusFromPreflight(status: GiteaPreflightStatus | undefined): GiteaStatus {
  if (!status?.configured) {
    return 'not-configured'
  }
  if (status.tokenConfigured && !status.authenticated) {
    return 'not-authenticated'
  }
  return 'configured'
}

function ghStatusFromPreflight(status: PreflightStatus['gh']): GhStatus {
  if (!status.installed) {
    return 'not-installed'
  }
  return status.authenticated ? 'connected' : 'not-authenticated'
}

function glabStatusFromPreflight(status: PreflightStatus['glab']): GlabStatus {
  if (!status?.installed) {
    return 'not-installed'
  }
  return status.authenticated ? 'connected' : 'not-authenticated'
}

function bitbucketStatusFromPreflight(status: PreflightStatus['bitbucket']): BitbucketStatus {
  if (!status?.configured) {
    return 'not-configured'
  }
  return status.authenticated ? 'connected' : 'not-authenticated'
}

function maybeChecking<T extends string>(
  provider: PreflightRefreshProvider,
  refreshingProviders: ReadonlySet<PreflightRefreshProvider>,
  status: T
): T | 'checking' {
  return refreshingProviders.has(provider) ? 'checking' : status
}

export function getPreflightIntegrationStatuses(
  preflightStatus: PreflightStatus | null,
  refreshingProviders: ReadonlySet<PreflightRefreshProvider>
): PreflightIntegrationStatuses {
  if (!preflightStatus) {
    return {
      ghStatus: 'checking',
      glabStatus: 'checking',
      bitbucketStatus: 'checking',
      bitbucketAccount: null,
      azureDevOpsStatus: 'checking',
      azureDevOpsAccount: null,
      azureDevOpsBaseUrl: null,
      giteaStatus: 'checking',
      giteaAccount: null,
      giteaBaseUrl: null
    }
  }

  const bitbucket = preflightStatus.bitbucket
  const azureDevOps = preflightStatus.azureDevOps
  const gitea = preflightStatus.gitea
  return {
    ghStatus: maybeChecking('gh', refreshingProviders, ghStatusFromPreflight(preflightStatus.gh)),
    glabStatus: maybeChecking(
      'glab',
      refreshingProviders,
      glabStatusFromPreflight(preflightStatus.glab)
    ),
    bitbucketStatus: maybeChecking(
      'bitbucket',
      refreshingProviders,
      bitbucketStatusFromPreflight(bitbucket)
    ),
    bitbucketAccount: bitbucket?.account ?? null,
    azureDevOpsStatus: maybeChecking(
      'azureDevOps',
      refreshingProviders,
      tokenApiStatusFromPreflight(azureDevOps)
    ),
    azureDevOpsAccount: azureDevOps?.account ?? null,
    azureDevOpsBaseUrl: azureDevOps?.baseUrl ?? null,
    giteaStatus: maybeChecking('gitea', refreshingProviders, giteaStatusFromPreflight(gitea)),
    giteaAccount: gitea?.account ?? null,
    giteaBaseUrl: gitea?.baseUrl ?? null
  }
}
