// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudGitHubRepository } from '@/lib/orca-cloud/use-orca-cloud-github-repositories'

const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/orca-cloud/use-orca-cloud-github-repositories', () => ({
  invalidateOrcaCloudGitHubRepositories: invalidate
}))

import {
  GITHUB_HANDOFF_POLL_MS,
  GITHUB_HANDOFF_WAIT_MS,
  useGitHubAccessHandoff
} from './use-github-access-handoff'

function repo(fullName: string): OrcaCloudGitHubRepository {
  return { fullName, url: `https://github.com/${fullName}`, private: true }
}

function setup(initial: OrcaCloudGitHubRepository[] | null) {
  const onReread = vi.fn()
  const onNewRepository = vi.fn()
  const hook = renderHook(
    ({ repos }: { repos: OrcaCloudGitHubRepository[] | null }) =>
      useGitHubAccessHandoff({ repos, onReread, onNewRepository }),
    { initialProps: { repos: initial } }
  )
  return { hook, onReread, onNewRepository }
}

describe('REPO-ACCESS-REFRESH: back from GitHub, the new repository shows up and is picked', () => {
  let focused = true
  beforeEach(() => {
    vi.useFakeTimers()
    focused = true
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    invalidate.mockReset()
  })

  it('re-reads on focus and picks the repository that was not listed before', () => {
    const { hook, onReread, onNewRepository } = setup([repo('acme/api')])
    act(() => hook.result.current.begin())
    expect(hook.result.current.waiting).toBe(true)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(invalidate).toHaveBeenCalled()
    expect(onReread).toHaveBeenCalledOnce()
    // The same list again: still waiting.
    hook.rerender({ repos: [repo('acme/api')] })
    expect(hook.result.current.waiting).toBe(true)
    hook.rerender({ repos: [repo('acme/api'), repo('acme/web')] })
    expect(onNewRepository).toHaveBeenCalledWith('acme/web')
    expect(hook.result.current.waiting).toBe(false)
  })

  it('polls only while this window has focus, and gives up after a while', () => {
    const { hook, onReread, onNewRepository } = setup([])
    act(() => hook.result.current.begin())
    focused = false
    act(() => vi.advanceTimersByTime(GITHUB_HANDOFF_POLL_MS * 3))
    expect(onReread).not.toHaveBeenCalled()
    focused = true
    act(() => vi.advanceTimersByTime(GITHUB_HANDOFF_POLL_MS))
    expect(onReread).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(GITHUB_HANDOFF_WAIT_MS))
    expect(hook.result.current.waiting).toBe(false)
    const calls = onReread.mock.calls.length
    act(() => vi.advanceTimersByTime(GITHUB_HANDOFF_POLL_MS * 2))
    expect(onReread.mock.calls.length).toBe(calls)
    expect(onNewRepository).not.toHaveBeenCalled()
  })

  it('takes the first answer as the baseline when the list had not loaded yet', () => {
    const { hook, onNewRepository } = setup(null)
    act(() => hook.result.current.begin())
    hook.rerender({ repos: [repo('acme/api')] })
    expect(onNewRepository).not.toHaveBeenCalled()
    hook.rerender({ repos: [repo('acme/api'), repo('acme/new')] })
    expect(onNewRepository).toHaveBeenCalledWith('acme/new')
  })

  it('stops waiting when the person picks or clears on their own', () => {
    const { hook, onNewRepository } = setup([repo('acme/api')])
    act(() => hook.result.current.begin())
    act(() => hook.result.current.cancel())
    hook.rerender({ repos: [repo('acme/api'), repo('acme/web')] })
    expect(onNewRepository).not.toHaveBeenCalled()
  })
})
