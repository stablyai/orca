// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: { repos: never[] }) => T): T => selector({ repos: [] })
}))
const auth = vi.hoisted(() => {
  const state: { identity: string } = { identity: 'profile\0owner\0org\0owner' }
  return state
})
vi.mock('./orca-cloud-identity', () => ({ useOrcaCloudIdentityKey: () => auth.identity }))

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
    auth.identity = 'profile\0owner\0org\0owner'
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

  it('Retry shows as reading until GitHub answers', async () => {
    list.mockResolvedValueOnce({ ok: false, code: 'failed', message: 'down' })
    const { result } = renderHook(() => useOrcaCloudGitHubRepositories(true))
    await waitFor(() => expect(result.current.unavailable).toBe(true))
    let answer: (value: unknown) => void = () => {}
    list.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    act(() => result.current.retry())
    expect(result.current.retrying).toBe(true)
    await act(async () => answer(page('acme/api')))
    await waitFor(() => expect(result.current.retrying).toBe(false))
    expect(result.current.repos?.map((r) => r.fullName)).toEqual(['acme/api'])
  })

  it('owner → member → owner, then a restart: every step reads the list again, none shows a stale empty list', async () => {
    list.mockResolvedValueOnce(page('acme/api'))
    const view = renderHook(() => useOrcaCloudGitHubRepositories(true))
    await waitFor(() => expect(view.result.current.repos).toHaveLength(1))
    // As a member the team's list may come back empty or refused.
    auth.identity = 'profile\0member\0org\0member'
    list.mockResolvedValueOnce(page())
    view.rerender()
    await waitFor(() => expect(view.result.current.repos).toEqual([]))
    // Back as the owner: a new identity, so a new read, not the member's answer.
    auth.identity = 'profile\0owner\0org\0owner'
    list.mockResolvedValueOnce({ ok: false, code: 'unauthorized', message: 'settling' })
    view.rerender()
    await waitFor(() => expect(view.result.current.unavailable).toBe(true))
    view.unmount()
    // Restart: nothing in memory survives; the composer's first open reads again.
    invalidateOrcaCloudGitHubRepositories()
    list.mockResolvedValueOnce(page('acme/api'))
    const reopened = renderHook(() => useOrcaCloudGitHubRepositories(true))
    await waitFor(() => expect(reopened.result.current.repos).toHaveLength(1))
    expect(list).toHaveBeenCalledTimes(4)
  })
})
