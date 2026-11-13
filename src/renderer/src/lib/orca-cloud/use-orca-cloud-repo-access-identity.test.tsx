// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { orcaCloudIdentityKey } from './orca-cloud-identity'
import { invalidateOrcaCloudRepoAccess, useOrcaCloudRepoAccess } from './use-orca-cloud-repo-access'

const REPO_URL = 'https://github.com/acme/web'
const getRepoAccess = vi.fn()

function connected(orgId: string): OrcaProfileAuthStatus {
  return {
    activeProfileId: 'p1',
    configured: true,
    state: 'connected',
    persistence: 'encrypted',
    cloud: {
      cloudProfileId: 'cp1',
      userId: 'u1',
      email: 'neil@example.com',
      activeOrgId: orgId,
      linkedAt: 1
    }
  }
}

const signedOut: OrcaProfileAuthStatus = {
  activeProfileId: 'p1',
  configured: true,
  state: 'unconfigured',
  persistence: 'encrypted'
}

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(window, { api: { orcaCloudWorkspace: { getRepoAccess } } }))
  useAppStore.setState({
    repos: [
      {
        id: 'web',
        path: '/code/web',
        displayName: 'web',
        badgeColor: '#888',
        addedAt: 1,
        gitRemoteIdentity: {
          canonicalKey: 'github.com/acme/web',
          remoteName: 'origin',
          remoteUrl: REPO_URL
        }
      } satisfies Repo
    ],
    orcaProfileAuthStatus: connected('o1')
  })
})
afterEach(() => {
  cleanup()
  invalidateOrcaCloudRepoAccess()
  getRepoAccess.mockReset()
  vi.unstubAllGlobals()
})

it('keys identity by account and team, and is empty while signed out', () => {
  expect(orcaCloudIdentityKey(connected('o1'))).not.toBe(orcaCloudIdentityKey(connected('o2')))
  // GH-LIST-MISSING: an owner → member → owner switch on the same team reads team answers again.
  const asRole = (role: string): OrcaProfileAuthStatus => ({
    ...connected('o1'),
    organizations: [{ orgId: 'o1', name: 'Team', role }]
  })
  expect(orcaCloudIdentityKey(asRole('owner'))).not.toBe(orcaCloudIdentityKey(asRole('member')))
  expect(orcaCloudIdentityKey(signedOut)).toBe('')
  expect(orcaCloudIdentityKey(null)).toBe('')
})

it('drops a cached "Done" for GitHub after sign-out and asks again after a team switch', async () => {
  getRepoAccess.mockResolvedValue({
    ok: true,
    value: { access: 'granted', owner: 'acme', repo: REPO_URL }
  })
  const { result } = renderHook(() => useOrcaCloudRepoAccess('web'))
  await waitFor(() => expect(result.current.state).toBe('ok'))

  // Signed out, the control plane can't tell: the row must not stay "Done" from the cache.
  getRepoAccess.mockResolvedValue({ ok: false, code: 'unauthorized', message: 'x' })
  act(() => useAppStore.setState({ orcaProfileAuthStatus: signedOut }))
  await waitFor(() => expect(result.current.state).toBe('unknown'))
  expect(getRepoAccess).toHaveBeenCalledTimes(2)

  // Another team: its own answer, not the first team's cached one.
  getRepoAccess.mockResolvedValue({
    ok: true,
    value: { access: 'missing', owner: 'acme', repo: REPO_URL }
  })
  act(() => useAppStore.setState({ orcaProfileAuthStatus: connected('o2') }))
  await waitFor(() => expect(result.current.state).toBe('needs-install'))
  expect(getRepoAccess).toHaveBeenCalledTimes(3)
})
