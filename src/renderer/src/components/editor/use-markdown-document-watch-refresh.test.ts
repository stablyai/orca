// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { useMarkdownDocumentWatchRefresh } from './use-markdown-document-watch-refresh'

let root: Root
let container: HTMLDivElement

function Harness({
  refresh
}: {
  refresh: (requireFresh: boolean, freshAfter: number) => Promise<void>
}): null {
  useMarkdownDocumentWatchRefresh({
    enabled: true,
    worktreePath: '/repo',
    runtimeEnvironmentId: null,
    refresh
  })
  return null
}

function change(events: FsChangeEvent[]): void {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: { runtimeEnvironmentId: null, payload: { worktreePath: '/repo', events } }
    })
  )
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useMarkdownDocumentWatchRefresh', () => {
  it('asks for a scan fresher than the latest change in the window', async () => {
    const refresh = vi.fn(async () => {})
    await act(async () => root.render(createElement(Harness, { refresh })))
    change([{ kind: 'create', absolutePath: '/repo/a.md' }])
    await advance(100)
    const latestChangeAt = performance.now()
    change([{ kind: 'create', absolutePath: '/repo/b.md' }])
    await advance(100)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(false, latestChangeAt)
  })

  it('keeps one slow scan in flight and follows up once it settles', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          setTimeout(() => {
            inFlight--
            resolve()
          }, 1000)
        })
    )
    await act(async () => root.render(createElement(Harness, { refresh })))
    // Watch batches arrive every 100 ms under sustained writes; each scan takes 1 s.
    for (let i = 0; i < 30; i++) {
      change([{ kind: 'create', absolutePath: `/repo/n${i}.md` }])
      await advance(100)
    }
    await advance(2000)
    expect(maxInFlight).toBe(1)
    // One scan per settled scan plus the trailing follow-up, not one per batch.
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('recovers from a scan that never settles', async () => {
    const refresh = vi
      .fn<(requireFresh: boolean, freshAfter: number) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockResolvedValue(undefined)
    await act(async () => root.render(createElement(Harness, { refresh })))
    // Local and UNC listings have no timeout; later changes must not stay frozen behind one.
    for (let i = 0; i < 20; i++) {
      change([{ kind: 'create', absolutePath: `/repo/h${i}.md` }])
      await advance(5_000)
    }
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('lets a slow scan publish while membership changes never stop', async () => {
    const scans: { startedAt: number; settledAt?: number }[] = []
    const refresh = vi.fn(() => {
      const scan: { startedAt: number; settledAt?: number } = {
        startedAt: Date.now()
      }
      scans.push(scan)
      // Why: a 40 s listing outlives the 30 s watchdog.
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          scan.settledAt = Date.now()
          resolve()
        }, 40_000)
      )
    })
    await act(async () => root.render(createElement(Harness, { refresh })))
    for (let i = 0; i < 60; i++) {
      change([{ kind: 'create', absolutePath: `/repo/s${i}.md` }])
      await advance(5_000)
    }
    // A scan's result publishes only if no newer scan started before it settled.
    const published = scans.filter(
      (scan, index) =>
        scan.settledAt !== undefined &&
        scans.slice(index + 1).every((later) => later.startedAt >= scan.settledAt!)
    )
    expect(published.length).toBeGreaterThanOrEqual(2)
  })
})
