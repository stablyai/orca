import { describe, expect, it } from 'vitest'
import type { PreflightStatus } from '../../../../preload/api-types'
import {
  getPreflightIntegrationStatuses,
  giteaStatusFromPreflight,
  tokenApiStatusFromPreflight
} from './integrations-pane-status'

const connectedPreflight: PreflightStatus = {
  git: { installed: true },
  gh: { installed: true, authenticated: true },
  glab: { installed: true, authenticated: true },
  bitbucket: { configured: true, authenticated: true, account: 'bb-user' },
  azureDevOps: {
    configured: true,
    authenticated: true,
    account: 'ado-user',
    baseUrl: 'https://dev.azure.com/acme',
    tokenConfigured: true
  },
  gitea: {
    configured: true,
    authenticated: true,
    account: 'gitea-user',
    baseUrl: 'https://gitea.example/api/v1',
    tokenConfigured: true
  }
}

describe('tokenApiStatusFromPreflight', () => {
  it('treats token-only Azure DevOps setup as configured while base URL is inferred later', () => {
    expect(
      tokenApiStatusFromPreflight({
        configured: true,
        authenticated: false,
        account: null,
        baseUrl: null,
        tokenConfigured: true
      })
    ).toBe('configured')
  })

  it('marks configured Azure DevOps credentials as unauthenticated after auth failure', () => {
    expect(
      tokenApiStatusFromPreflight({
        configured: true,
        authenticated: false,
        account: null,
        baseUrl: 'https://dev.azure.com/acme',
        tokenConfigured: true
      })
    ).toBe('not-authenticated')
  })
})

describe('giteaStatusFromPreflight', () => {
  it('keeps missing Gitea setup optional and flags configured auth failures', () => {
    expect(giteaStatusFromPreflight(undefined)).toBe('not-configured')
    expect(
      giteaStatusFromPreflight({
        configured: true,
        authenticated: false,
        account: null,
        baseUrl: 'https://gitea.example/api/v1',
        tokenConfigured: true
      })
    ).toBe('not-authenticated')
  })
})

describe('getPreflightIntegrationStatuses', () => {
  it('shows checking before preflight status arrives', () => {
    expect(getPreflightIntegrationStatuses(null, new Set()).ghStatus).toBe('checking')
  })

  it('derives connected status labels and account details from preflight state', () => {
    expect(getPreflightIntegrationStatuses(connectedPreflight, new Set())).toMatchObject({
      ghStatus: 'connected',
      glabStatus: 'connected',
      bitbucketStatus: 'connected',
      bitbucketAccount: 'bb-user',
      azureDevOpsStatus: 'configured',
      azureDevOpsAccount: 'ado-user',
      giteaStatus: 'configured',
      giteaAccount: 'gitea-user'
    })
  })

  it('keeps a manually refreshed provider in checking state until its request settles', () => {
    expect(
      getPreflightIntegrationStatuses(connectedPreflight, new Set(['glab', 'gitea']))
    ).toMatchObject({
      ghStatus: 'connected',
      glabStatus: 'checking',
      bitbucketStatus: 'connected',
      giteaStatus: 'checking'
    })
  })
})
