// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SnapshotCapabilityModule from './terminal-provider-snapshot-capability'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { makeTab, makeWorktree } from '@/store/slices/store-test-helpers'

const { collectPtyIds } = vi.hoisted(() => ({ collectPtyIds: vi.fn() }))

vi.mock('./terminal-provider-snapshot-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotCapabilityModule>()
  collectPtyIds.mockImplementation(actual.collectTerminalProviderSnapshotPtyIds)
  return { ...actual, collectTerminalProviderSnapshotPtyIds: collectPtyIds }
})

import { useAppStore } from '@/store'
import { createTerminalProviderSnapshotBoundPtyIdsSelector } from './terminal-provider-snapshot-bound-pty-ids'

const initialState = useAppStore.getInitialState()
const TAB_COUNT = 40
const WORKTREE_ID = 'repo::worktree-0'

function tabId(index: number): string {
  return `tab-${index}`
}

function leafLayout(index: number, activeLeafId: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: `leaf-a-${index}` },
      second: { type: 'leaf' as const, leafId: `leaf-b-${index}` }
    },
    activeLeafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [`leaf-a-${index}`]: `pty-${index}-a`,
      [`leaf-b-${index}`]: `pty-${index}-b`
    }
  }
}

function seedWorkspace(): void {
  const worktrees = Array.from({ length: 8 }, (_, index) =>
    makeWorktree({ id: `repo::worktree-${index}`, repoId: 'repo' })
  )
  const tabs = Array.from({ length: TAB_COUNT }, (_, index) =>
    makeTab({ id: tabId(index), worktreeId: WORKTREE_ID, ptyId: `pty-${index}` })
  )
  useAppStore.setState({
    worktreesByRepo: { repo: worktrees },
    tabsByWorktree: { [WORKTREE_ID]: tabs },
    ptyIdsByTabId: Object.fromEntries(tabs.map((tab, index) => [tab.id, [`pty-${index}`]])),
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab, index) => [tab.id, leafLayout(index, `leaf-a-${index}`)])
    )
  })
}

describe('createTerminalProviderSnapshotBoundPtyIdsSelector', () => {
  let select: ReturnType<typeof createTerminalProviderSnapshotBoundPtyIdsSelector>
  let boundPtyIds: string[]
  let unsubscribe: () => void

  beforeEach(() => {
    useAppStore.setState(initialState, true)
    seedWorkspace()
    collectPtyIds.mockClear()
    select = createTerminalProviderSnapshotBoundPtyIdsSelector()
    boundPtyIds = select(useAppStore.getState())
    // Why subscribe: this mirrors how zustand drives the selector — once per store write.
    unsubscribe = useAppStore.subscribe((state) => {
      boundPtyIds = select(state)
    })
  })

  afterEach(() => {
    unsubscribe()
    useAppStore.setState(initialState, true)
  })

  // Why: the collector walks every tab and every layout leaf, and both of these rewrite the maps it
  // reads without being able to change the pty set.
  it('never re-collects for agent title frames or active-leaf moves', () => {
    expect(collectPtyIds).toHaveBeenCalledTimes(1)
    const initialBoundPtyIds = boundPtyIds

    for (let index = 0; index < TAB_COUNT; index += 1) {
      useAppStore.getState().updateTabTitle(tabId(index), `agent frame ${index}`)
    }
    for (let index = 0; index < TAB_COUNT; index += 1) {
      useAppStore.getState().setTabLayout(tabId(index), leafLayout(index, `leaf-b-${index}`))
    }

    expect(useAppStore.getState().tabsByWorktree).not.toBe(initialState.tabsByWorktree)
    expect(useAppStore.getState().terminalLayoutsByTabId[tabId(0)]?.activeLeafId).toBe('leaf-b-0')
    expect(collectPtyIds).toHaveBeenCalledTimes(1)
    expect(boundPtyIds).toBe(initialBoundPtyIds)
  })

  it('re-collects and republishes when the pty set actually changes', () => {
    const expectRecollect = (label: string, mutate: () => void): string[] => {
      const before = collectPtyIds.mock.calls.length
      const previousBoundPtyIds = boundPtyIds
      mutate()
      expect(collectPtyIds.mock.calls.length, label).toBeGreaterThan(before)
      expect(boundPtyIds, label).not.toBe(previousBoundPtyIds)
      return boundPtyIds
    }

    expectRecollect('pty bound to a leaf', () => {
      useAppStore.getState().replaceTerminalLayoutPanePtyId(tabId(0), 'leaf-b-0', 'pty-0-b-next')
    })
    expect(boundPtyIds).toContain('pty-0-b-next')

    expectRecollect('split pty bound to a tab', () => {
      useAppStore.setState((state) => ({
        ptyIdsByTabId: { ...state.ptyIdsByTabId, [tabId(1)]: ['pty-1', 'pty-1-split'] }
      }))
    })
    expect(boundPtyIds).toContain('pty-1-split')

    expectRecollect('split pty unbound from a tab', () => {
      useAppStore.setState((state) => ({
        ptyIdsByTabId: { ...state.ptyIdsByTabId, [tabId(1)]: ['pty-1'] }
      }))
    })
    expect(boundPtyIds).not.toContain('pty-1-split')

    expectRecollect('pending reconnect pty appears', () => {
      useAppStore.setState({ pendingReconnectPtyIdByTabId: { [tabId(2)]: 'pty-2-reconnect' } })
    })
    expect(boundPtyIds).toContain('pty-2-reconnect')

    expectRecollect('leaf added', () => {
      useAppStore.getState().setTabLayout(tabId(3), {
        ...leafLayout(3, 'leaf-a-3'),
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-a-3' },
          second: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-b-3' },
            second: { type: 'leaf', leafId: 'leaf-c-3' }
          }
        },
        ptyIdsByLeafId: {
          'leaf-a-3': 'pty-3-a',
          'leaf-b-3': 'pty-3-b',
          'leaf-c-3': 'pty-3-c'
        }
      })
    })
    expect(boundPtyIds).toContain('pty-3-c')

    expectRecollect('leaf removed', () => {
      useAppStore.getState().setTabLayout(tabId(3), leafLayout(3, 'leaf-a-3'))
    })
    expect(boundPtyIds).not.toContain('pty-3-c')

    expectRecollect('tab added', () => {
      useAppStore.setState((state) => ({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [WORKTREE_ID]: [
            ...(state.tabsByWorktree[WORKTREE_ID] ?? []),
            makeTab({ id: 'tab-new', worktreeId: WORKTREE_ID, ptyId: 'pty-new' })
          ]
        }
      }))
    })
    expect(boundPtyIds).toContain('pty-new')

    expectRecollect('tab removed', () => {
      useAppStore.setState((state) => ({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [WORKTREE_ID]: (state.tabsByWorktree[WORKTREE_ID] ?? []).filter(
            (tab) => tab.id !== 'tab-new'
          )
        }
      }))
    })
    expect(boundPtyIds).not.toContain('pty-new')
  })

  // Why: the id array identity is the synchronization loop's restart trigger, so a rebuild that
  // lands on the same set must reuse the previous array rather than restart the loop.
  it('keeps the array identity when a rebuild lands on the same id set', () => {
    const initialBoundPtyIds = boundPtyIds

    useAppStore.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: (state.tabsByWorktree[WORKTREE_ID] ?? []).toReversed()
      }
    }))

    expect(collectPtyIds).toHaveBeenCalledTimes(2)
    expect(boundPtyIds).toBe(initialBoundPtyIds)
  })
})
