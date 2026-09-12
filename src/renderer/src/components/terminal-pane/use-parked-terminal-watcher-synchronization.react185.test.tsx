/** @vitest-environment happy-dom */
import { act, StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE_ID = 'repo::/parked-watcher-sync'
const TAB_ID = 'tab-1'
const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const FIRST_PTY_ID = `${WORKTREE_ID}@@session-1`
const OLD_SECOND_PTY_ID = `${WORKTREE_ID}@@session-2`
const NEW_SECOND_PTY_ID = `${WORKTREE_ID}@@session-3`

const harness = vi.hoisted(() => ({
  syncCalls: 0,
  disposeCalls: 0,
  reconciliationPtyReads: 0,
  watchedPtyIds: new Set<string>()
}))

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
    terminalLayoutsByTabId: {} as Record<string, TerminalLayoutSnapshot>
  }))
  return { useAppStore }
})

vi.mock('./terminal-parked-tab-watchers', async () => {
  const { useAppStore } = await import('../../store')
  return {
    disposeParkedTerminalWatchersForWorktree: () => {
      harness.disposeCalls += 1
      harness.watchedPtyIds.clear()
    },
    syncParkedTerminalTabWatchers: (args: {
      tabs: readonly TerminalTab[]
      parkedTabIds: ReadonlySet<string>
    }) => {
      harness.syncCalls += 1
      const state = useAppStore.getState()
      harness.watchedPtyIds.clear()
      for (const tab of args.tabs) {
        if (!args.parkedTabIds.has(tab.id)) {
          continue
        }
        const layoutPtyIds = Object.values(
          state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
        )
        for (const ptyId of layoutPtyIds.length > 0 ? layoutPtyIds : [tab.ptyId]) {
          if (ptyId) {
            harness.watchedPtyIds.add(ptyId)
          }
        }
      }
    }
  }
})

import { useAppStore } from '../../store'
import { disposeParkedTerminalWatchersForWorktree } from './terminal-parked-tab-watchers'
import {
  captureParkedTerminalPaneCandidates,
  capturedPanesByTabId
} from './terminal-parked-watcher-registry'
import { useParkedTerminalWatcherSynchronization } from './use-parked-terminal-watcher-synchronization'

const terminalTabs = [{ id: TAB_ID, ptyId: FIRST_PTY_ID }] as TerminalTab[]
const parkedTabIds = new Set([TAB_ID])
const EMPTY_PARKED_TAB_IDS = new Set<string>()
const firstUnparkedTabs = ['tab-a', 'tab-b', 'tab-c'].map(
  (id) => ({ id, ptyId: `${WORKTREE_ID}@@${id}` }) as TerminalTab
)
const secondUnparkedTabs = ['tab-d', 'tab-e', 'tab-f'].map(
  (id) => ({ id, ptyId: `${WORKTREE_ID}@@${id}` }) as TerminalTab
)

function splitLayout(secondPtyId: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: FIRST_LEAF_ID },
      second: { type: 'leaf', leafId: SECOND_LEAF_ID }
    },
    activeLeafId: FIRST_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [FIRST_LEAF_ID]: FIRST_PTY_ID,
      [SECOND_LEAF_ID]: secondPtyId
    }
  }
}

function WatcherSynchronizationHarness(): null {
  useParkedTerminalWatcherSynchronization({
    worktreeId: WORKTREE_ID,
    terminalTabs,
    inputsKey: JSON.stringify([[TAB_ID, FIRST_PTY_ID, null]]),
    assignmentsKey: JSON.stringify([[TAB_ID, 'group-1', false]]),
    parkedTabIds
  })
  // Models the pre-fix sibling disposal effect that StrictMode replays after synchronization.
  useEffect(() => () => disposeParkedTerminalWatchersForWorktree(WORKTREE_ID), [])
  return null
}

function UnparkedWatcherSynchronizationHarness({
  worktreeId,
  tabs
}: {
  worktreeId: string
  tabs: readonly TerminalTab[]
}): null {
  useParkedTerminalWatcherSynchronization({
    worktreeId,
    terminalTabs: tabs,
    inputsKey: worktreeId,
    assignmentsKey: worktreeId,
    parkedTabIds: EMPTY_PARKED_TAB_IDS
  })
  return null
}

describe('parked terminal watcher synchronization', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    harness.syncCalls = 0
    harness.disposeCalls = 0
    harness.reconciliationPtyReads = 0
    harness.watchedPtyIds.clear()
    useAppStore.setState({
      ptyIdsByTabId: { [TAB_ID]: [FIRST_PTY_ID, OLD_SECOND_PTY_ID] },
      runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'active', 2: 'split' } },
      terminalLayoutsByTabId: { [TAB_ID]: splitLayout(OLD_SECOND_PTY_ID) }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    capturedPanesByTabId.delete(TAB_ID)
    container.remove()
  })

  it('reinstates parked watchers after StrictMode effect replay cleanup', () => {
    root = createRoot(container)

    act(() => {
      root?.render(
        <StrictMode>
          <WatcherSynchronizationHarness />
        </StrictMode>
      )
    })

    expect(harness.disposeCalls).toBeGreaterThanOrEqual(1)
    expect(harness.syncCalls).toBe(2)
    expect(harness.watchedPtyIds).toEqual(new Set([FIRST_PTY_ID, OLD_SECOND_PTY_ID]))
  })

  it('resynchronizes a parked split when only its detached PTY and layout change', () => {
    root = createRoot(container)
    act(() => {
      root?.render(<WatcherSynchronizationHarness />)
    })
    expect(harness.watchedPtyIds).toContain(OLD_SECOND_PTY_ID)

    act(() => {
      useAppStore.setState({
        ptyIdsByTabId: { [TAB_ID]: [FIRST_PTY_ID, NEW_SECOND_PTY_ID] },
        terminalLayoutsByTabId: { [TAB_ID]: splitLayout(NEW_SECOND_PTY_ID) }
      })
    })

    expect(harness.syncCalls).toBe(2)
    expect(harness.watchedPtyIds).toEqual(new Set([FIRST_PTY_ID, NEW_SECOND_PTY_ID]))

    act(() => {
      useAppStore.setState({
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: '⠋ active', 2: 'new split title' } }
      })
    })
    expect(harness.syncCalls).toBe(2)

    act(() => {
      useAppStore.setState({
        terminalLayoutsByTabId: {
          [TAB_ID]: { ...splitLayout(NEW_SECOND_PTY_ID), activeLeafId: SECOND_LEAF_ID }
        }
      })
    })
    expect(harness.syncCalls).toBe(3)

    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, [
      { ptyId: FIRST_PTY_ID, paneId: 10, leafId: FIRST_LEAF_ID, drivesTabTitle: false },
      { ptyId: NEW_SECOND_PTY_ID, paneId: 11, leafId: SECOND_LEAF_ID, drivesTabTitle: true }
    ])
    act(() => {
      root?.render(<WatcherSynchronizationHarness />)
    })
    expect(harness.syncCalls).toBe(4)
  })

  it('does not scan unparked worktrees on an unrelated store write', () => {
    const capturedPaneGet = vi.spyOn(capturedPanesByTabId, 'get')
    const ptyIdsByTabId = new Proxy({} as Record<string, string[]>, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          harness.reconciliationPtyReads += 1
        }
        return Reflect.get(target, property, receiver)
      }
    })
    useAppStore.setState({ ptyIdsByTabId })
    root = createRoot(container)
    act(() => {
      root?.render(
        <>
          <UnparkedWatcherSynchronizationHarness
            worktreeId="repo::/unparked-a"
            tabs={firstUnparkedTabs}
          />
          <UnparkedWatcherSynchronizationHarness
            worktreeId="repo::/unparked-b"
            tabs={secondUnparkedTabs}
          />
        </>
      )
    })
    harness.reconciliationPtyReads = 0
    const syncCallsAfterMount = harness.syncCalls

    act(() => {
      useAppStore.setState({ sortEpoch: 1 })
    })

    expect(harness.reconciliationPtyReads).toBe(0)
    expect(capturedPaneGet).not.toHaveBeenCalled()
    expect(harness.syncCalls).toBe(syncCallsAfterMount)
  })
})

function ConfigurableWatcherSynchronizationHarness({
  inputsKey,
  assignmentsKey,
  activationDeferredMountTabIds
}: {
  inputsKey: string
  assignmentsKey: string
  activationDeferredMountTabIds?: ReadonlySet<string> | null
}): null {
  useParkedTerminalWatcherSynchronization({
    worktreeId: WORKTREE_ID,
    terminalTabs,
    inputsKey,
    assignmentsKey,
    parkedTabIds,
    activationDeferredMountTabIds
  })
  return null
}

describe('parked terminal watcher synchronization key semantics', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  function renderHarness(props: {
    inputsKey?: string
    assignmentsKey?: string
    activationDeferredMountTabIds?: ReadonlySet<string> | null
  }): void {
    act(() => {
      root?.render(
        <ConfigurableWatcherSynchronizationHarness
          inputsKey={props.inputsKey ?? 'inputs'}
          assignmentsKey={props.assignmentsKey ?? 'assignments'}
          activationDeferredMountTabIds={props.activationDeferredMountTabIds ?? null}
        />
      )
    })
  }

  beforeEach(() => {
    harness.syncCalls = 0
    harness.disposeCalls = 0
    harness.watchedPtyIds.clear()
    useAppStore.setState({
      ptyIdsByTabId: { [TAB_ID]: [FIRST_PTY_ID, OLD_SECOND_PTY_ID] },
      runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'active', 2: 'split' } },
      terminalLayoutsByTabId: { [TAB_ID]: splitLayout(OLD_SECOND_PTY_ID) }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    capturedPanesByTabId.delete(TAB_ID)
    container.remove()
  })

  it('does not resynchronize when nothing the key covers changed', () => {
    renderHarness({})
    expect(harness.syncCalls).toBe(1)
    renderHarness({})
    renderHarness({})
    act(() => {
      useAppStore.setState({ sortEpoch: 1 })
    })
    expect(harness.syncCalls).toBe(1)
  })

  // Why: a key that stopped covering one of these would strand a parked pane
  // that never reconciles.
  it.each([
    ['pty ids', () => useAppStore.setState({ ptyIdsByTabId: { [TAB_ID]: [FIRST_PTY_ID] } })],
    [
      'layout root shape',
      () =>
        useAppStore.setState({
          terminalLayoutsByTabId: {
            [TAB_ID]: {
              ...splitLayout(OLD_SECOND_PTY_ID),
              root: {
                type: 'split',
                direction: 'horizontal',
                first: { type: 'leaf', leafId: FIRST_LEAF_ID },
                second: { type: 'leaf', leafId: SECOND_LEAF_ID }
              }
            }
          }
        })
    ],
    [
      'layout active leaf',
      () =>
        useAppStore.setState({
          terminalLayoutsByTabId: {
            [TAB_ID]: { ...splitLayout(OLD_SECOND_PTY_ID), activeLeafId: SECOND_LEAF_ID }
          }
        })
    ],
    [
      'layout leaf pty ids',
      () =>
        useAppStore.setState({
          terminalLayoutsByTabId: { [TAB_ID]: splitLayout(NEW_SECOND_PTY_ID) }
        })
    ],
    [
      'runtime pane title slots',
      () =>
        useAppStore.setState({
          runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'active', 2: 'split', 3: 'third' } }
        })
    ],
    [
      'captured pane registry',
      () =>
        captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, [
          { ptyId: FIRST_PTY_ID, paneId: 10, leafId: FIRST_LEAF_ID, drivesTabTitle: true }
        ])
    ]
  ])('resynchronizes when %s changes', (_label, mutate) => {
    renderHarness({})
    expect(harness.syncCalls).toBe(1)
    act(() => {
      mutate()
    })
    // A registry mutation is not a store write, so drive the render it rides on.
    renderHarness({})
    expect(harness.syncCalls).toBe(2)
  })

  it('resynchronizes when a caller-supplied key or tab set changes', () => {
    renderHarness({ inputsKey: 'a', assignmentsKey: 'b' })
    expect(harness.syncCalls).toBe(1)
    renderHarness({ inputsKey: 'a2', assignmentsKey: 'b' })
    expect(harness.syncCalls).toBe(2)
    renderHarness({ inputsKey: 'a2', assignmentsKey: 'b2' })
    expect(harness.syncCalls).toBe(3)
    renderHarness({
      inputsKey: 'a2',
      assignmentsKey: 'b2',
      activationDeferredMountTabIds: new Set([TAB_ID])
    })
    expect(harness.syncCalls).toBe(4)
  })

  // Why: fragments are concatenated, so a scheme that let one field borrow a
  // character from its neighbour would collide and skip a synchronization.
  it('keeps adjacent key fragments from borrowing each other characters', () => {
    renderHarness({ inputsKey: 'ab', assignmentsKey: 'c' })
    expect(harness.syncCalls).toBe(1)
    renderHarness({ inputsKey: 'a', assignmentsKey: 'bc' })
    expect(harness.syncCalls).toBe(2)
    renderHarness({
      inputsKey: 'a',
      assignmentsKey: 'bc',
      activationDeferredMountTabIds: new Set(['x', 'y'])
    })
    expect(harness.syncCalls).toBe(3)
    renderHarness({
      inputsKey: 'a',
      assignmentsKey: 'bc',
      activationDeferredMountTabIds: new Set(['xy'])
    })
    expect(harness.syncCalls).toBe(4)
  })
})
