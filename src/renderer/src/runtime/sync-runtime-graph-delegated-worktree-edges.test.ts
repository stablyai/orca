import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DelegatedWorktreeEdge } from '../../../shared/worktree/delegated-worktree-edge'
import type { RuntimeSyncWindowGraphResult } from '../../../shared/runtime-session-contracts'
import type { AppState } from '../store/types'

vi.mock('@/components/terminal-pane/pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

import {
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './sync-runtime-graph'

const EDGE: DelegatedWorktreeEdge = {
  parentWorktreeId: 'repo-1::/home/alex/coordinator',
  childHostId: 'runtime:env-1',
  childWorktreeId: 'repo-remote::/home/ubuntu/worker',
  dispatchId: 'ctx_1'
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * Drives real graph syncs against a store that only records what the delegated-edge
 * setter was given, and returns the store's value after each scripted host reply.
 */
async function publishedEdgesAfter(
  replies: readonly Partial<RuntimeSyncWindowGraphResult>[]
): Promise<readonly DelegatedWorktreeEdge[]> {
  vi.useFakeTimers()
  let published: readonly DelegatedWorktreeEdge[] = []
  const syncWindowGraph = vi.fn()
  for (const reply of replies) {
    syncWindowGraph.mockResolvedValueOnce(reply)
  }
  vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
  vi.stubGlobal('HTMLElement', class HTMLElement {})
  const storeState = {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    setDelegatedWorktreeEdges: (edges: readonly DelegatedWorktreeEdge[]) => {
      published = edges
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the graph publication path reads only the members declared above; the rest of AppState is never touched on this path.
  setRuntimeGraphStoreStateGetter(() => storeState as unknown as AppState)
  setRuntimeGraphSyncEnabled(true)
  for (let index = 0; index < replies.length; index += 1) {
    if (index > 0) {
      scheduleRuntimeGraphSync()
    }
    await vi.advanceTimersByTimeAsync(20)
    await Promise.resolve()
    await Promise.resolve()
  }
  expect(syncWindowGraph).toHaveBeenCalledTimes(replies.length)
  return published
}

describe('syncRuntimeGraph delegated worktree edges', () => {
  it('commits the edges the host published', async () => {
    expect(await publishedEdgesAfter([{ delegatedWorktreeEdges: [EDGE] }])).toEqual([EDGE])
  })

  it('keeps the live edges through a window where the host db cannot answer', async () => {
    // The placements still exist; only the db is momentarily unreachable. Committing
    // [] here would un-nest every delegated card until the next successful sync.
    expect(
      await publishedEdgesAfter([
        { delegatedWorktreeEdges: [EDGE] },
        { delegatedWorktreeEdgesUnavailable: true }
      ])
    ).toEqual([EDGE])
  })

  it('clears the edges when the host answers that it coordinated none', async () => {
    expect(
      await publishedEdgesAfter([
        { delegatedWorktreeEdges: [EDGE] },
        { delegatedWorktreeEdges: [] }
      ])
    ).toEqual([])
  })

  it('clears the edges against a host that predates the field', async () => {
    // Rule 1 skew: an older host omits both members, which still reads as zero.
    expect(await publishedEdgesAfter([{ delegatedWorktreeEdges: [EDGE] }, {}])).toEqual([])
  })
})
