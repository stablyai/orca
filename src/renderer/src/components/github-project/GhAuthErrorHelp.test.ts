import { describe, expect, it, vi } from 'vitest'
import type { GhAuthDiagnostic } from '../../../../shared/github-auth-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { buildRemediation } from './GhAuthErrorHelp'

function diagnostic(overrides: Partial<GhAuthDiagnostic> = {}): GhAuthDiagnostic {
  return {
    ghAvailable: true,
    activeAccount: {
      host: 'ghe.acme.test:8443',
      user: 'alice',
      active: true,
      envToken: null,
      source: 'keyring',
      scopes: ['project', 'read:org', 'repo']
    },
    accounts: [],
    envTokenInProcess: null,
    missingScopes: [],
    requiredScopes: ['project', 'read:org', 'repo'],
    hasKeyringFallback: false,
    requiredHost: 'ghe.acme.test:8443',
    requiredHostAuthenticated: true,
    ...overrides
  }
}

describe('GitHub Project auth remediation host routing', () => {
  it('uses the requested GHES host while the diagnostic is still loading', () => {
    expect(
      buildRemediation('Sign in required.', 'auth_required', null, 'ghe.acme.test:8443').commands
    ).toEqual([
      {
        label: 'Copy command',
        command: 'gh auth login --hostname ghe.acme.test:8443'
      }
    ])
    expect(
      buildRemediation('Missing scope.', 'scope_missing', null, 'ghe.acme.test:8443').commands
    ).toEqual([
      {
        label: 'Copy command',
        command: 'gh auth refresh --hostname ghe.acme.test:8443 -s project -s read:org -s repo'
      }
    ])
  })

  it('keeps the GHES host on best-effort refresh advice after diagnostics complete', () => {
    expect(buildRemediation('Access denied.', 'scope_missing', diagnostic()).commands).toEqual([
      {
        label: 'Copy refresh command',
        command: 'gh auth refresh --hostname ghe.acme.test:8443 -s project -s read:org -s repo'
      }
    ])
  })
})
