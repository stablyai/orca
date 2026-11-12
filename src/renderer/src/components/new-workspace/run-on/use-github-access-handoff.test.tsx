// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudGitHubRepository } from '@/lib/orca-cloud/use-orca-cloud-github-repositories'

const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/orca-cloud/use-orca-cloud-github-repositories', () => ({
  invalidateOrcaCloudGitHubRepositories: invalidate
}))

import {
  GITHUB_HANDOFF_POLL_DELAYS_MS,
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
    expect(hook.result.current.phase).toBe('waiting')
    act(() => vi.advanceTimersByTime(FOCUS_GAP))
    focused = false
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(invalidate).toHaveBeenCalled()
    expect(onReread).toHaveBeenCalledOnce()
    // The same list again: still waiting.
    hook.rerender({ repos: [repo('acme/api')] })
    expect(hook.result.current.phase).toBe('waiting')
    hook.rerender({ repos: [repo('acme/api'), repo('acme/web')] })
    expect(onNewRepository).toHaveBeenCalledWith('acme/web')
    expect(hook.result.current.phase).toBe('idle')
  })

  it('backs off, reads only while focused, then stops quietly with a way to check again', () => {
    const { hook, onReread, onNewRepository } = setup([repo('acme/api')])
    act(() => hook.result.current.begin())
    focused = false
    act(() => vi.advanceTimersByTime(GITHUB_HANDOFF_POLL_DELAYS_MS[0] * 3))
    expect(onReread).not.toHaveBeenCalled()
    focused = true
    act(() => vi.advanceTimersByTime(GITHUB_HANDOFF_WAIT_MS))
    // Backing off: about ten reads in the whole wait, not one every 4 s.
    expect(onReread.mock.calls.length).toBeGreaterThan(1)
    expect(onReread.mock.calls.length).toBeLessThanOrEqual(12)
    expect(hook.result.current.phase).toBe('timed-out')
    const calls = onReread.mock.calls.length
    act(() => vi.advanceTimersByTime(GITHUB_HANDOFF_POLL_DELAYS_MS.at(-1)! * 3))
    expect(onReread.mock.calls.length).toBe(calls)
    expect(onNewRepository).not.toHaveBeenCalled()
    // Check again: one read now, waiting again from the same baseline.
    act(() => hook.result.current.checkAgain())
    expect(onReread.mock.calls.length).toBe(calls + 1)
    expect(hook.result.current.phase).toBe('waiting')
    hook.rerender({ repos: [repo('acme/api'), repo('acme/late')] })
    expect(onNewRepository).toHaveBeenCalledWith('acme/late')
  })

  it('takes the first answer as the baseline when the list had not loaded yet', () => {
    const { hook, onNewRepository } = setup(null)
    act(() => hook.result.current.begin())
    hook.rerender({ repos: [repo('acme/api')] })
    expect(onNewRepository).not.toHaveBeenCalled()
    hook.rerender({ repos: [repo('acme/api'), repo('acme/new')] })
    expect(onNewRepository).toHaveBeenCalledWith('acme/new')
  })

  it('a pick or clear by the person ends the wait: nothing is picked over it later', () => {
    const { hook, onNewRepository } = setup([repo('acme/api')])
    act(() => hook.result.current.begin())
    act(() => hook.result.current.cancel())
    hook.rerender({ repos: [repo('acme/api'), repo('acme/web'), repo('acme/www')] })
    expect(onNewRepository).not.toHaveBeenCalled()
    expect(hook.result.current.phase).toBe('idle')
  })
})

const FOCUS_GAP = 2_000
