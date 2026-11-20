import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import type { WorkspaceSessionPatch } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceSessionEntriesPatch } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import * as launchPersistence from '../../agent-session/launch/structured-agent-session-launch-persistence'
import { createSessionWriteSubscriber } from './session-write-subscriber'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import { patchWorkspaceSessionByHost, type SessionApi } from './workspace-session-host-persistence'

// Perf contract (#43932): one tab switch re-sent every workspace's tab, group and layout maps to main.

const FLEET_WORKTREES = 100
const DEBOUNCE_MS = 150

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Entries a value carries to main: one per key of a keyed record, one per item, one per scalar. */
function entriesIn(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length
  }
  return value !== null && typeof value === 'object' ? Object.keys(value).length : 1
}

function fieldEntries(fields: WorkspaceSessionPatch): number {
  return Object.values(fields).reduce<number>((sum, value) => sum + entriesIn(value), 0)
}

/** A session API that counts every entry sent, by the entries path or the whole-field fallback. */
function countingSessionApi() {
  const sent = { writes: 0, entries: 0 }
  const api: SessionApi = {
    get: async () => {
      throw new Error('not read in this flow')
    },
    patch: async (fields) => {
      sent.writes += 1
      sent.entries += fieldEntries(fields)
    },
    patchEntries: async ({ fields, entries }: WorkspaceSessionEntriesPatch) => {
      sent.writes += 1
      sent.entries += fieldEntries(fields)
      for (const change of Object.values(entries)) {
        sent.entries += Object.keys(change?.set ?? {}).length + (change?.remove.length ?? 0)
      }
      return { status: 'applied' }
    }
  }
  return { api, sent }
}

/** `size` worktrees with two tabs each, made by the store's createTab so unified tabs, groups and layouts exist. */
function seedFleet(store: ReturnType<typeof createTestStore>, size: number) {
  const worktrees = Array.from({ length: size }, (_, index) =>
    makeWorktree({
      id: `${TEST_REPO.id}::/wt-${index}`,
      repoId: TEST_REPO.id,
      path: `/wt-${index}`
    })
  )
  seedStore(store, {
    worktreesByRepo: { [TEST_REPO.id]: worktrees },
    activeWorktreeId: worktrees[7]!.id
  })
  for (const [index, worktree] of worktrees.entries()) {
    store.getState().createTab(worktree.id, undefined, undefined, { id: `tab-${index}-a` })
    store.getState().createTab(worktree.id, undefined, undefined, { id: `tab-${index}-b` })
  }
  store.getState().setActiveTab('tab-7-a')
  store.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
}

it('one tab switch sends only that workspace’s session entries to main', async () => {
  // Building a worktree's saved tab session looks up each of its groups' launch slots once.
  const sessionsBuilt = vi.spyOn(launchPersistence, 'structuredLaunchSlotIds')
  const store = createTestStore()
  const { api, sent } = countingSessionApi()
  const acknowledged = new AcknowledgedWorkspaceSessionEntries()
  const stop = createSessionWriteSubscriber({
    store,
    debounceMs: DEBOUNCE_MS,
    persist: ({ patch }) =>
      patchWorkspaceSessionByHost(api, patch, store.getState(), acknowledged).written
  })
  try {
    // The first save sends whole fields; main acknowledges them.
    seedFleet(store, FLEET_WORKTREES)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const before = { ...sent }
    const sessionsBefore = sessionsBuilt.mock.calls.length

    store.getState().setActiveTab('tab-7-b')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    // Worktree 7's active tab, tab session and group focus, plus the window's active tab.
    expect(sent).toEqual({ writes: before.writes + 1, entries: before.entries + 4 })
    expect(sessionsBuilt.mock.calls.length - sessionsBefore).toBe(1)
  } finally {
    stop()
  }
})
