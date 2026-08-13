import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))
vi.mock('@/components/terminal-pane/shutdown-buffer-captures', () => ({
  shutdownBufferCaptures: vi.fn()
}))

// @ts-expect-error -- minimal preload API stub for the slice's IPC writes
globalThis.window = { api: {} }

import {
  createTestStore,
  makeTab,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import type { GeneratedTabTitleUpdate } from './terminal-tab-title-batch'

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

  it('preserves ordered duplicate updates and last-owner duplicate-id routing', () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        first: [makeTab({ id: 'duplicate-tab', worktreeId: 'first', title: 'First owner' })],
        second: [makeTab({ id: 'duplicate-tab', worktreeId: 'second', title: 'Second owner' })]
      }
    })

    store.getState().updateTabTitles([
      { tabId: 'duplicate-tab', title: 'Intermediate' },
      { tabId: 'duplicate-tab', title: 'Final' }
    ])

    expect(store.getState().tabsByWorktree.first?.[0]?.title).toBe('First owner')
    expect(store.getState().tabsByWorktree.second?.[0]?.title).toBe('Final')
  })

  it('updates every same-owner backing duplicate but only the first unified row', () => {
    const store = createTestStore()
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      tabsByWorktree: {
        owner: [
          makeTab({ id: 'duplicate-tab', worktreeId: 'owner', title: 'First backing' }),
          makeTab({ id: 'duplicate-tab', worktreeId: 'owner', title: 'Second backing' })
        ]
      },
      unifiedTabsByWorktree: {
        owner: [
          makeUnifiedTab({
            id: 'duplicate-tab',
            worktreeId: 'owner',
            groupId: 'group-1',
            label: 'First visible'
          }),
          makeUnifiedTab({
            id: 'duplicate-tab',
            worktreeId: 'owner',
            groupId: 'group-2',
            label: 'Second visible'
          })
        ]
      }
    })

    store.getState().updateTabTitles([{ tabId: 'duplicate-tab', title: 'Final live title' }])
    store.getState().setGeneratedTabTitlesFromAgentPrompts([
      {
        paneKey: makePaneKey('duplicate-tab', LEAF_ID),
        prompt: 'Generated duplicate title for remote startup'
      }
    ])

    expect(store.getState().tabsByWorktree.owner?.map((tab) => tab.title)).toEqual([
      'Final live title',
      'Final live title'
    ])
    expect(store.getState().tabsByWorktree.owner?.map((tab) => tab.generatedTitle)).toEqual([
      'Generated duplicate title for remote',
      'Generated duplicate title for remote'
    ])
    expect(store.getState().unifiedTabsByWorktree.owner?.map((tab) => tab.label)).toEqual([
      'Final live title',
      'Second visible'
    ])
    expect(store.getState().unifiedTabsByWorktree.owner?.map((tab) => tab.generatedLabel)).toEqual([
      'Generated duplicate title for remote',
      undefined
    ])
  })

  it('matches sequential live and generated title semantics in event order', () => {
    const sequentialStore = createTestStore()
    const batchStore = createTestStore()
    const fixture = {
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      tabsByWorktree: {
        owner: [makeTab({ id: 'tab-1', worktreeId: 'owner', title: 'Terminal 1' })]
      },
      unifiedTabsByWorktree: {
        owner: [makeUnifiedTab({ id: 'tab-1', worktreeId: 'owner', groupId: 'group-1' })]
      }
    }
    seedStore(sequentialStore, structuredClone(fixture))
    seedStore(batchStore, structuredClone(fixture))
    const liveUpdates = [
      { tabId: 'tab-1', title: 'Codex' },
      { tabId: 'tab-1', title: '⠋ Codex is thinking' },
      { tabId: 'tab-1', title: '⠙ Codex is thinking' },
      { tabId: 'tab-1', title: '' },
      { tabId: 'tab-1', title: 'Final stable title' }
    ]
    const generatedUpdates = [
      { paneKey: makePaneKey('tab-1', LEAF_ID), prompt: 'First generated title wins here' },
      { paneKey: makePaneKey('tab-1', LEAF_ID), prompt: 'Ignored later generated title' },
      {
        paneKey: makePaneKey('tab-1', LEAF_ID),
        prompt: 'Forced replacement generated title',
        options: { replaceExistingGeneratedTitle: true }
      }
    ]

    for (const update of liveUpdates) {
      sequentialStore.getState().updateTabTitle(update.tabId, update.title)
    }
    for (const update of generatedUpdates) {
      sequentialStore
        .getState()
        .setGeneratedTabTitleFromAgentPrompt(update.paneKey, update.prompt, update.options)
    }
    batchStore.getState().updateTabTitles(liveUpdates)
    batchStore.getState().setGeneratedTabTitlesFromAgentPrompts(generatedUpdates)

    expect(batchStore.getState().tabsByWorktree).toEqual(sequentialStore.getState().tabsByWorktree)
    expect(batchStore.getState().unifiedTabsByWorktree).toEqual(
      sequentialStore.getState().unifiedTabsByWorktree
    )
    expect(batchStore.getState().sortEpoch).toBe(sequentialStore.getState().sortEpoch)
  })

  it('coalesces generated titles while preserving first-write and replacement semantics', () => {
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

    store.getState().setGeneratedTabTitlesFromAgentPrompts(updates)

    unsubscribe()
    expect(publications).toBe(1)
    expect(fixture.getIdReads()).toBeLessThanOrEqual(305)
    expect(store.getState().tabsByWorktree['wt-0']?.[0]?.generatedTitle).toBe(
      'Replacement title for a newer dispatch'
    )
    expect(store.getState().tabsByWorktree['wt-99']?.[0]?.generatedTitle).toBe(
      'Refactor remote module 99 for startup'
    )
  })
})
