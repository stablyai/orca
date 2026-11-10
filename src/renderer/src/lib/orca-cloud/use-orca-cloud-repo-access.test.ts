import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  REPO_ACCESS_CACHE_MS,
  fetchOrcaCloudRepoAccess,
  invalidateOrcaCloudRepoAccess
} from './use-orca-cloud-repo-access'

const REPO = 'https://github.com/acme/web'
const getRepoAccess = vi.fn()

beforeEach(() => {
  vi.stubGlobal('window', { api: { orcaCloudWorkspace: { getRepoAccess } } })
})
afterEach(() => {
  invalidateOrcaCloudRepoAccess()
  vi.unstubAllGlobals()
  getRepoAccess.mockReset()
})

it('caches an answer for 5 minutes, shares one request, and re-asks when forced', async () => {
  getRepoAccess.mockResolvedValue({
    ok: true,
    value: { access: 'missing', owner: 'acme', repo: REPO }
  })
  const [a, b] = await Promise.all([
    fetchOrcaCloudRepoAccess(REPO, { now: 0 }),
    fetchOrcaCloudRepoAccess(REPO, { now: 0 })
  ])
  expect(a).toEqual(b)
  expect(getRepoAccess).toHaveBeenCalledOnce()
  await fetchOrcaCloudRepoAccess(REPO, { now: REPO_ACCESS_CACHE_MS - 1_000 })
  expect(getRepoAccess).toHaveBeenCalledOnce()
  await fetchOrcaCloudRepoAccess(REPO, { force: true, now: 0 })
  expect(getRepoAccess).toHaveBeenCalledTimes(2)
  await fetchOrcaCloudRepoAccess(REPO, { setupSessionId: 'cs_abcdefghijklmnopqrstuv', now: 0 })
  expect(getRepoAccess).toHaveBeenLastCalledWith({
    repoUrl: REPO,
    setupSessionId: 'cs_abcdefghijklmnopqrstuv'
  })
})

it('does not cache "couldn’t tell" (signed out, offline)', async () => {
  getRepoAccess.mockResolvedValueOnce({ ok: false, code: 'unauthorized', message: 'x' })
  expect(await fetchOrcaCloudRepoAccess(REPO, { now: 0 })).toBeNull()
  getRepoAccess.mockResolvedValueOnce({
    ok: true,
    value: { access: 'granted', owner: 'acme', repo: REPO }
  })
  expect(await fetchOrcaCloudRepoAccess(REPO, { now: 0 })).toMatchObject({ access: 'granted' })
})
