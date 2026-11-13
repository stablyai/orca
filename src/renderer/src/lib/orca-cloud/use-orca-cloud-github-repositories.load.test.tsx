// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: { repos: never[] }) => T): T => selector({ repos: [] })
}))
vi.mock('./orca-cloud-identity', () => ({ useOrcaCloudIdentityKey: () => 'profile\0user\0org' }))

import {
  invalidateOrcaCloudGitHubRepositories,
  useOrcaCloudGitHubRepositories
} from './use-orca-cloud-github-repositories'

const list = vi.fn()

function page(...names: string[]) {
  return {
    ok: true,
    value: {
      repositories: names.map((fullName) => ({
        fullName,
        url: `https://github.com/${fullName}`,
        private: true
      })),
      nextCursor: null
    }
  }
}

describe('GH-LIST-MISSING: the GitHub list is never silently empty', () => {
  beforeEach(() => {
    invalidateOrcaCloudGitHubRepositories()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { orcaCloudWorkspace: { listGitHubRepositories: list } }
    })
  })
  afterEach(() => {
    cleanup()
    list.mockReset()
  })

  it('a failed read says unavailable (not "no repositories"), is not cached, and Retry reads again', async () => {
    list.mockResolvedValueOnce({ ok: false, code: 'unauthorized', message: 'Sign in again.' })
    const { result } = renderHook(() => useOrcaCloudGitHubRepositories(true))
    await waitFor(() => expect(result.current.unavailable).toBe(true))
    expect(result.current.repos).toBeNull()
    list.mockResolvedValueOnce(page('acme/api'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.repos?.map((r) => r.fullName)).toEqual(['acme/api']))
    expect(result.current.unavailable).toBe(false)
  })

  it('a failed read on one open is asked again on the next open (no 5-minute empty cache)', async () => {
    list.mockResolvedValueOnce({ ok: false, code: 'failed', message: 'GitHub unavailable' })
    const first = renderHook(() => useOrcaCloudGitHubRepositories(true))
    await waitFor(() => expect(first.result.current.unavailable).toBe(true))
    first.unmount()
    list.mockResolvedValueOnce(page('acme/web'))
    const second = renderHook(() => useOrcaCloudGitHubRepositories(true))
    await waitFor(() =>
      expect(second.result.current.repos?.map((r) => r.fullName)).toEqual(['acme/web'])
    )
  })

  it('an empty answer is asked again on the next open; a non-empty one is reused', async () => {
    list.mockResolvedValueOnce(page())
    const first = renderHook(() => useOrcaCloudGitHubRepositories(true))
    await waitFor(() => expect(first.result.current.repos).toEqual([]))
    first.unmount()
    list.mockResolvedValueOnce(page('acme/new'))
    const second = renderHook(() => useOrcaCloudGitHubRepositories(true))
    await waitFor(() =>
      expect(second.result.current.repos?.map((r) => r.fullName)).toEqual(['acme/new'])
    )
    second.unmount()
    const calls = list.mock.calls.length
    const third = renderHook(() => useOrcaCloudGitHubRepositories(true))
    await waitFor(() =>
      expect(third.result.current.repos?.map((r) => r.fullName)).toEqual(['acme/new'])
    )
    expect(list.mock.calls.length).toBe(calls)
  })
})
