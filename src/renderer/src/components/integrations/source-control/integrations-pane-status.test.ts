import { describe, expect, it } from 'vitest'
import type { PreflightStatus } from '../../../../../preload/api/preflight/preflight-api'
import { getPreflightIntegrationStatuses } from './integrations-pane-status'

const connectedPreflight: PreflightStatus = {
  git: { installed: true },
  gh: { installed: true, authenticated: true },
  glab: { installed: true, authenticated: true },
  bitbucket: { configured: true, authenticated: true, account: 'bb-user' },
  azureDevOps: {
    configured: true,
    authenticated: true,
    account: 'ado-user',
    baseUrl: 'https://dev.azure.com/org',
    tokenConfigured: true
  },
  gitea: {
    configured: true,
    authenticated: true,
    account: 'gitea-user',
    baseUrl: 'https://gitea.example/api/v1',
    tokenConfigured: true,
    authError: null
  }
}

describe('getPreflightIntegrationStatuses', () => {
  it('returns null giteaAuthError when checking or authenticated', () => {
    expect(getPreflightIntegrationStatuses(null, new Set())).toMatchObject({
      giteaStatus: 'checking',
      giteaAccount: null,
      giteaBaseUrl: null,
      giteaAuthError: null
    })

    expect(getPreflightIntegrationStatuses(connectedPreflight, new Set())).toMatchObject({
      giteaStatus: 'configured',
      giteaAccount: 'gitea-user',
      giteaBaseUrl: 'https://gitea.example/api/v1',
      giteaAuthError: null
    })
  })

  it('forwards Gitea authError from preflight when token auth fails', () => {
    expect(
      getPreflightIntegrationStatuses(
        {
          ...connectedPreflight,
          gitea: {
            configured: true,
            authenticated: false,
            account: null,
            baseUrl: 'https://gitea.example/api/v1',
            tokenConfigured: true,
            authError: 'token does not have required scope(s)'
          }
        },
        new Set()
      )
    ).toMatchObject({
      giteaStatus: 'not-authenticated',
      giteaAuthError: 'token does not have required scope(s)'
    })
  })
})
