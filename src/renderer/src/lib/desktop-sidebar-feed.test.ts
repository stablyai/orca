// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { SidebarInputsFeed } from '../../../main/runtime/sidebar-inputs/sidebar-inputs-feed'
import { testDomain } from '../../../main/runtime/sidebar-inputs/sidebar-inputs-feed.test-fixture'
import type { SidebarInputsChangedEvent } from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import { makeRepo, makeWorktree } from '@/components/worktree-jump-palette-test-fixtures'
import { buildWorkspaceRows } from '../../../shared/sidebar-list/workspace-rows'

function workspaceRow(id: string) {
  return Object.fromEntries(
    buildWorkspaceRows({
      worktrees: [makeWorktree(id, id, { hostId: 'local' })],
      folderWorkspaces: [],
      repos: [makeRepo()],
      lineageById: {}
    })
  )
}

/** Main's feed behind the window's IPC: notices out, reads in. */
function connectMain() {
  const workspaces = testDomain('workspaces', workspaceRow('repo-1::/w/a'))
  const review = testDomain('review', {
    'local|repo-1::/w/a': { provider: 'github', reviewState: 'open' }
  })
  const notices = new Set<(event: SidebarInputsChangedEvent) => void>()
  const feed = new SidebarInputsFeed(
    () => [workspaces.domain, review.domain],
    (event) => notices.forEach((notice) => notice(event))
  )
  feed.acquire('desktop-renderer:1:1')
  let failNext = false
  const call = vi.fn(async ({ params }: { method: string; params?: unknown }) => {
    if (failNext) {
      failNext = false
      return { ok: false, error: { code: 'unavailable', message: 'starting' } }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader sends SidebarInputsReadParams.
    return { ok: true, result: await feed.read(params as Parameters<typeof feed.read>[0]) }
  })
  Object.assign(window, {
    api: {
      runtime: {
        call,
        onSidebarInputsChanged: (listener: (event: SidebarInputsChangedEvent) => void) => {
          notices.add(listener)
          return () => notices.delete(listener)
        }
      }
    }
  })
  return { workspaces, call, failOnce: () => (failNext = true) }
}

async function load() {
  vi.resetModules()
  return import('./desktop-sidebar-feed')
}

describe('desktop sidebar feed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('installs main’s inputs on mount and follows each notice', async () => {
    const main = connectMain()
    const reader = await load()
    const { result } = renderHook(() => reader.useDesktopSidebarFeed())
    await vi.waitFor(() => expect(result.current?.domains.workspaces.size).toBe(1))
    const first = result.current
    main.workspaces.set('local|repo-1::/w/b', workspaceRow('repo-1::/w/b')['local|repo-1::/w/b'])
    await act(() => vi.advanceTimersByTimeAsync(60))
    await vi.waitFor(() => expect(result.current?.domains.workspaces.size).toBe(2))
    // A domain the change did not touch keeps its parsed entities.
    expect(first?.domains.review.size).toBe(1)
    expect(result.current?.domains.review).toBe(first?.domains.review)
  })

  it('keeps following main while no list is mounted, so a remount draws current rows', async () => {
    const main = connectMain()
    const reader = await load()
    const first = renderHook(() => reader.useDesktopSidebarFeed())
    await vi.waitFor(() => expect(first.result.current?.domains.workspaces.size).toBe(1))
    first.unmount()
    main.workspaces.set('local|repo-1::/w/b', workspaceRow('repo-1::/w/b')['local|repo-1::/w/b'])
    await act(() => vi.advanceTimersByTimeAsync(60))
    await vi.waitFor(() => expect(main.call).toHaveBeenCalledTimes(2))
    await act(() => vi.advanceTimersByTimeAsync(0))
    const second = renderHook(() => reader.useDesktopSidebarFeed())
    // The first render, before any read the remount itself starts could answer.
    expect(second.result.current?.domains.workspaces.size).toBe(2)
  })

  it('answers a refresh with an install from that read or later', async () => {
    connectMain()
    const reader = await load()
    const installs: number[] = []
    reader.onDesktopSidebarFeedInstalled((installed) => installs.push(installed.readId))
    renderHook(() => reader.useDesktopSidebarFeed())
    await vi.waitFor(() => expect(installs).toHaveLength(1))
    const readId = reader.refreshDesktopSidebarFeed()
    await vi.waitFor(() => expect(installs.at(-1)).toBeGreaterThanOrEqual(readId))
  })

  it('retries a failed first read on its own', async () => {
    const main = connectMain()
    main.failOnce()
    const reader = await load()
    const { result } = renderHook(() => reader.useDesktopSidebarFeed())
    await vi.waitFor(() => expect(main.call).toHaveBeenCalledOnce())
    expect(result.current).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    await vi.waitFor(() => expect(result.current?.domains.workspaces.size).toBe(1))
  })
})
