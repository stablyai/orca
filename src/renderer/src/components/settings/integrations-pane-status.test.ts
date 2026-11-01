import { describe, expect, it } from 'vitest'
import type { PreflightStatus } from '../../../../preload/api-types'
import {
  getPreflightIntegrationStatuses,
  giteaStatusFromPreflight
} from './integrations-pane-status'

const unconfiguredGitea = {
  configured: false,
  authenticated: false,
  account: null,
  baseUrl: null,
  tokenConfigured: false
}

function preflight(overrides: Partial<PreflightStatus>): PreflightStatus {
  return {
    git: { installed: true },
    gh: { installed: true, authenticated: true },
    ...overrides
  }
}

describe('giteaStatusFromPreflight', () => {
  it('is configured when tea is authenticated without a token', () => {
    expect(
      giteaStatusFromPreflight(unconfiguredGitea, {
        installed: true,
        authenticated: true
      })
    ).toBe('configured')
  })

  it('is configured when only a valid token is configured', () => {
    expect(
      giteaStatusFromPreflight({
        ...unconfiguredGitea,
        configured: true,
        authenticated: true,
        tokenConfigured: true
      })
    ).toBe('configured')
  })

  it('prefers an authenticated tea login over a failing token', () => {
    expect(
      giteaStatusFromPreflight(
        { ...unconfiguredGitea, configured: true, tokenConfigured: true },
        { installed: true, authenticated: true }
      )
    ).toBe('configured')
  })

  it('stays not-configured when neither source is usable', () => {
    expect(
      giteaStatusFromPreflight(unconfiguredGitea, {
        installed: true,
        authenticated: false
      })
    ).toBe('not-configured')
  })
})

describe('getPreflightIntegrationStatuses gitea tea status', () => {
  it('reports tea connected and gitea configured', () => {
    const result = getPreflightIntegrationStatuses(
      preflight({ tea: { installed: true, authenticated: true } }),
      new Set()
    )
    expect(result.giteaTeaStatus).toBe('connected')
    expect(result.giteaStatus).toBe('configured')
  })

  it('reports tea states for installed-unauthenticated and absent', () => {
    expect(
      getPreflightIntegrationStatuses(
        preflight({ tea: { installed: true, authenticated: false } }),
        new Set()
      ).giteaTeaStatus
    ).toBe('not-authenticated')
    expect(getPreflightIntegrationStatuses(preflight({}), new Set()).giteaTeaStatus).toBe(
      'not-installed'
    )
  })

  it('shows checking while gitea is refreshing', () => {
    const result = getPreflightIntegrationStatuses(preflight({}), new Set(['gitea']))
    expect(result.giteaTeaStatus).toBe('checking')
  })
})
