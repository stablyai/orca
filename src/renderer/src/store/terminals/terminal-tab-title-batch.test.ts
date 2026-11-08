import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { layoutApplyTestDouble } from '@/runtime/workspace-layout/testing/layout-apply-test-double'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  unregisterPtyDataHandlers: vi.fn()
}))
vi.mock('@/components/terminal-pane/snapshots/shutdown-buffer-captures', () => ({
  shutdownBufferCaptures: vi.fn()
}))

const main = layoutApplyTestDouble()
// @ts-expect-error -- minimal preload API stub for the slice's IPC writes
globalThis.window = { api: { runtime: { call: main.call } } }

import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
import { makeUnifiedTab } from '../slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import type { GeneratedTabTitleUpdate } from './terminal-tab-title-batch'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeScaleState(count: number) {
  const worktrees = Array.from({ length: count }, (_, index) =>
    makeWorktree({ id: `wt-${index}`, repoId: 'repo1' })
  )
  const tabsByWorktree = Object.fromEntries(
    worktrees.map((worktree, index) => [
      worktree.id,
      [makeTab({ id: `tab-${index}`, worktreeId: worktree.id })]
    ])
  )
  const unifiedTabsByWorktree = Object.fromEntries(
    worktrees.map((worktree, index) => [
      worktree.id,
      [makeUnifiedTab({ id: `tab-${index}`, worktreeId: worktree.id, groupId: 'group-1' })]
    ])
  )
  return {
    tabsByWorktree,
    unifiedTabsByWorktree,
    worktrees
  }
}

describe('terminal tab title batches', () => {
  it('updates each requested owner while preserving an untouched owner', () => {
    const store = createTestStore()
    const fixture = makeScaleState(3)
    seedStore(store, {
      worktreesByRepo: { repo1: fixture.worktrees },
      tabsByWorktree: fixture.tabsByWorktree,
      unifiedTabsByWorktree: fixture.unifiedTabsByWorktree
    })
    const untouchedTabs = fixture.tabsByWorktree['wt-2']
    store.getState().updateTabTitles(
      Array.from({ length: 2 }, (_, index) => ({
        tabId: `tab-${index}`,
        title: `Remote agent ${index}`
      }))
    )

    expect(store.getState().tabsByWorktree['wt-2']).toBe(untouchedTabs)
    expect(store.getState().tabsByWorktree['wt-0']?.[0]?.title).toBe('Remote agent 0')
    expect(store.getState().tabsByWorktree['wt-1']?.[0]?.title).toBe('Remote agent 1')
  })

  it('replaces an earlier title on the same owner', () => {
    const store = createTestStore()
    const fixture = makeScaleState(2)
    seedStore(store, {
      worktreesByRepo: { repo1: fixture.worktrees },
      tabsByWorktree: fixture.tabsByWorktree,
      unifiedTabsByWorktree: fixture.unifiedTabsByWorktree
    })
    store.getState().updateTabTitle('tab-1', 'First warm title')

    store.getState().updateTabTitle('tab-1', 'Second warm title')

    expect(store.getState().tabsByWorktree['wt-1']?.[0]?.title).toBe('Second warm title')
  })

  it('coalesces generated titles while preserving first-write and replacement semantics', () => {
    const store = createTestStore()
    const fixture = makeScaleState(2)
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      worktreesByRepo: { repo1: fixture.worktrees },
      tabsByWorktree: fixture.tabsByWorktree,
      unifiedTabsByWorktree: fixture.unifiedTabsByWorktree
    })
    const updates: GeneratedTabTitleUpdate[] = Array.from({ length: 2 }, (_, index) => ({
      paneKey: makePaneKey(`tab-${index}`, LEAF_ID),
      prompt: `Refactor remote module ${index} for startup performance`
    }))
    updates.push(
      {
        paneKey: makePaneKey('tab-0', LEAF_ID),
        prompt: 'This later prompt must not replace the first generated title'
      },
      {
        paneKey: makePaneKey('tab-0', LEAF_ID),
        prompt: 'Replacement title for a newer dispatch',
        options: { replaceExistingGeneratedTitle: true }
      }
    )

    main.commands.length = 0
    store.getState().setGeneratedTabTitlesFromAgentPrompts(updates)

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main derives batch titles from agent status; first-write/replacement coverage is in agent-generated-tab-titles.test.ts, with no window writes.
      expect(main.commands).toEqual([])
      expect(store.getState().tabsByWorktree['wt-0']?.[0]?.generatedTitle).toBeUndefined()
      return
    }
    expect(main.commands).toEqual([])
    const titleOf = (worktreeId: string): string | null | undefined =>
      store.getState().tabsByWorktree[worktreeId]?.[0]?.generatedTitle
    expect(titleOf('wt-0')).toBe('Replacement title for a newer dispatch')
    expect(titleOf('wt-1')).toBe('Refactor remote module 1 for startup')
  })
})
