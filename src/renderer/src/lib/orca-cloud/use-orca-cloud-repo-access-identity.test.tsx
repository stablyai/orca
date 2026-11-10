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
    persistence: 'keychain',
    cloud: {
      cloudProfileId: 'cp1',
      userId: 'u1',
      email: 'neil@example.com',
      activeOrgId: orgId,
      linkedAt: 1
    }
  } as OrcaProfileAuthStatus
}

const signedOut = { ...connected('o1'), state: 'unconfigured', cloud: undefined }

beforeEach(() => {
  vi.stubGlobal('api', { ...window.api, orcaCloudWorkspace: { getRepoAccess } })
  window.api = (globalThis as unknown as { api: typeof window.api }).api
  useAppStore.setState({
    repos: [
      {
        id: 'web',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/acme/web',
          remoteName: 'origin',
          remoteUrl: REPO_URL
        }
      } as Repo
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
  expect(orcaCloudIdentityKey(signedOut as OrcaProfileAuthStatus)).toBe('')
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
  act(() => useAppStore.setState({ orcaProfileAuthStatus: signedOut as OrcaProfileAuthStatus }))
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
