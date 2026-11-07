import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { layoutApplyTestDouble } from '@/runtime/layout-apply-test-double'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
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

import {
  createTestStore,
  makeTab,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import type { GeneratedTabTitleUpdate } from './terminal-tab-title-batch'
import { adoptTerminalTabOwnerMetadataOnlyBuckets } from './terminal-tab-owner-index'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeScaleState(count: number) {
  let idReads = 0
  const worktrees = Array.from({ length: count }, (_, index) =>
    makeWorktree({ id: `wt-${index}`, repoId: 'repo1' })
  )
  const tabsByWorktree = Object.fromEntries(
    worktrees.map((worktree, index) => {
      const tab = makeTab({ id: `tab-${index}`, worktreeId: worktree.id })
      const id = tab.id
      Object.defineProperty(tab, 'id', {
        configurable: true,
        enumerable: true,
        get() {
          idReads += 1
          return id
        }
      })
      return [worktree.id, [tab]]
    })
  )
  const unifiedTabsByWorktree = Object.fromEntries(
    worktrees.map((worktree, index) => [
      worktree.id,
      [makeUnifiedTab({ id: `tab-${index}`, worktreeId: worktree.id, groupId: 'group-1' })]
    ])
  )
  return {
    getIdReads: () => idReads,
    resetIdReads: () => {
      idReads = 0
    },
    tabsByWorktree,
    unifiedTabsByWorktree,
    worktrees
  }
}

describe('terminal tab title batches', () => {
  it('updates 100 owners with one publication and a linear owner-index pass', () => {
    const store = createTestStore()
    const fixture = makeScaleState(101)
    seedStore(store, {
      worktreesByRepo: { repo1: fixture.worktrees },
      tabsByWorktree: fixture.tabsByWorktree,
      unifiedTabsByWorktree: fixture.unifiedTabsByWorktree
    })
    const untouchedTabs = fixture.tabsByWorktree['wt-100']
    const baselineSortEpoch = store.getState().sortEpoch
    fixture.resetIdReads()
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    store.getState().updateTabTitles(
      Array.from({ length: 100 }, (_, index) => ({
        tabId: `tab-${index}`,
        title: `Remote agent ${index}`
      }))
    )

    unsubscribe()
    expect(publications).toBe(1)
    expect(fixture.getIdReads()).toBeLessThanOrEqual(305)
    expect(store.getState().tabsByWorktree['wt-100']).toBe(untouchedTabs)
    expect(store.getState().sortEpoch).toBe(baselineSortEpoch + 100)
    for (let index = 0; index < 100; index += 1) {
      expect(store.getState().tabsByWorktree[`wt-${index}`]?.[0]?.title).toBe(
        `Remote agent ${index}`
      )
    }
  })

  it('inspects only the changed bucket for a warm title change across 300 worktrees', () => {
    const store = createTestStore()
    const fixture = makeScaleState(300)
    seedStore(store, {
      worktreesByRepo: { repo1: fixture.worktrees },
      tabsByWorktree: fixture.tabsByWorktree,
      unifiedTabsByWorktree: fixture.unifiedTabsByWorktree
    })
    store.getState().updateTabTitle('tab-299', 'First warm title')

    const idReadsByWorktree = Array.from({ length: 300 }, () => 0)
    for (let index = 0; index < 300; index += 1) {
      const tab = store.getState().tabsByWorktree[`wt-${index}`]?.[0]
      if (!tab) {
        throw new Error(`missing scale tab ${index}`)
      }
      const id = tab.id
      Object.defineProperty(tab, 'id', {
        configurable: true,
        enumerable: true,
        get() {
          idReadsByWorktree[index] += 1
          return id
        }
      })
    }

    let outerKeyVisits = 0
    let bucketVisits = 0
    const currentTabsByWorktree = store.getState().tabsByWorktree
    const observedTabsByWorktree = new Proxy(currentTabsByWorktree, {
      ownKeys(target) {
        outerKeyVisits += 1
        return Reflect.ownKeys(target)
      },
      get(target, property, receiver) {
        if (typeof property === 'string' && property.startsWith('wt-')) {
          bucketVisits += 1
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
        return Reflect.get(target, property, receiver)
      }
    })
    adoptTerminalTabOwnerMetadataOnlyBuckets(currentTabsByWorktree, observedTabsByWorktree, [])
    store.setState({ tabsByWorktree: observedTabsByWorktree })
    outerKeyVisits = 0
    bucketVisits = 0

    store.getState().updateTabTitle('tab-299', 'Second warm title')

    expect(idReadsByWorktree[299]).toBeGreaterThan(0)
    expect(idReadsByWorktree.slice(0, 299).reduce((sum, count) => sum + count, 0)).toBe(0)
    expect(outerKeyVisits).toBe(1)
    // The unavoidable outer-map copy reads 300 buckets; staging and cache adoption
    // read the changed owner twice. A second fleet traversal would add 300 more.
    expect(bucketVisits).toBe(302)
    expect(store.getState().tabsByWorktree['wt-299']?.[0]?.title).toBe('Second warm title')
  })

  it('coalesces generated titles while preserving first-write and replacement semantics', async () => {
    const store = createTestStore()
    const fixture = makeScaleState(100)
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      worktreesByRepo: { repo1: fixture.worktrees },
      tabsByWorktree: fixture.tabsByWorktree,
      unifiedTabsByWorktree: fixture.unifiedTabsByWorktree
    })
    fixture.resetIdReads()
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })
    const updates: GeneratedTabTitleUpdate[] = Array.from({ length: 100 }, (_, index) => ({
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

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    unsubscribe()
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main derives batch titles from agent status; first-write/replacement coverage is in agent-generated-tab-titles.test.ts, with no window writes.
      expect(main.commands).toEqual([])
      expect(publications).toBe(0)
      expect(store.getState().tabsByWorktree['wt-0']?.[0]?.generatedTitle).toBeUndefined()
      return
    }
    expect(main.commands).toEqual([])
    expect(publications).toBe(1)
    expect(fixture.getIdReads()).toBeLessThanOrEqual(305)
    const titleOf = (worktreeId: string): string | null | undefined =>
      store.getState().tabsByWorktree[worktreeId]?.[0]?.generatedTitle
    expect(titleOf('wt-0')).toBe('Replacement title for a newer dispatch')
    expect(titleOf('wt-99')).toBe('Refactor remote module 99 for startup')
  })
})
