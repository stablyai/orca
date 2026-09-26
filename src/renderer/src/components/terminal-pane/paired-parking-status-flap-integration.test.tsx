// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { resetPairedRuntimeParkingEnvironmentIdsCacheForTest } from './paired-runtime-parking-capabilities'
import {
  canWatcherCoverParkedTerminalTab,
  disposeAllParkedTerminalWatchers,
  getParkedTerminalWatcherTabIds
} from './terminal-parked-tab-watchers'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'

const transport = vi.hoisted(() => ({ start: vi.fn(() => vi.fn()) }))

vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: transport.start
}))

const ENVIRONMENT_ID = 'parking-host'
const WORKTREE_ID = 'folder:paired-parking'
const RETAINED_TAB_ID = 'web-terminal-a'
const PARKED_TAB_ID = 'web-terminal-b'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const ASSIGNMENTS = new Map<string, { groupId: string; isActiveInGroup: boolean }>()
const PORTALS: never[] = []
const mounts = new Map<string, number>()
let parkedTabIds: ReadonlySet<string> = new Set()

function terminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: `remote:${ENVIRONMENT_ID}@@${id}`,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const TABS = [terminalTab(RETAINED_TAB_ID), terminalTab(PARKED_TAB_ID)]

function snapshot(
  sequence: number,
  verification: RuntimeHostStatusSnapshot['verification']
): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENVIRONMENT_ID,
    pairingRevision: 1,
    sequence,
    checkedAt: Date.now(),
    verification,
    transport: verification === 'verified' ? 'ready' : 'connecting',
    status: {
      runtimeId: 'runtime-1',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: 1,
      liveTabCount: 2,
      liveLeafCount: 2,
      capabilities: [TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY]
    }
  }
}

function PaneMount({ tabId }: { tabId: string }): null {
  useEffect(() => {
    mounts.set(tabId, (mounts.get(tabId) ?? 0) + 1)
  }, [tabId])
  return null
}

function ParkingHost(): React.JSX.Element {
  const terminalTabs = useAppStore((state) => state.tabsByWorktree[WORKTREE_ID])
  parkedTabIds = useTerminalTabColdParking({
    worktreeId: WORKTREE_ID,
    terminalTabs,
    assignments: ASSIGNMENTS,
    isWorktreeActive: false,
    activeTerminalTabId: null,
    coldParkTerminalPanes: false,
    shouldMeasureHiddenWorktree: false,
    activityTerminalPortals: PORTALS
  })
  return (
    <>
      {terminalTabs.map((tab) =>
        parkedTabIds.has(tab.id) ? null : <PaneMount key={tab.id} tabId={tab.id} />
      )}
    </>
  )
}

function publishStatus(sequence: number, verification: RuntimeHostStatusSnapshot['verification']) {
  act(() => {
    vi.advanceTimersByTime(4_000)
    useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(sequence, verification))
  })
}

describe('paired parking through live host-status publications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    mounts.clear()
    transport.start.mockClear()
    parkedTabIds = new Set()
    disposeAllParkedTerminalWatchers()
    resetPairedRuntimeParkingEnvironmentIdsCacheForTest()
    const layouts: Record<string, TerminalLayoutSnapshot> = {}
    for (const tab of TABS) {
      layouts[tab.id] = {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: tab.ptyId ?? '' }
      }
    }
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tabsByWorktree: { [WORKTREE_ID]: TABS },
      terminalLayoutsByTabId: layouts,
      runtimeEnvironments: [
        {
          id: ENVIRONMENT_ID,
          name: ENVIRONMENT_ID,
          createdAt: 1,
          updatedAt: 1,
          pairingRevision: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [
            { id: 'test-endpoint', kind: 'websocket', label: 'Test', endpoint: 'ws://x' }
          ],
          preferredEndpointId: 'test-endpoint'
        }
      ]
    })
    useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(1, 'verified'))
  })

  afterEach(() => {
    cleanup()
    disposeAllParkedTerminalWatchers()
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.useRealTimers()
  })

  it('keeps aged tabs parked and their watchers alive while only contact evidence changes', () => {
    render(<ParkingHost />)
    expect(parkedTabIds.size).toBe(0)
    act(() => vi.advanceTimersByTime(5 * 60_000))
    expect(parkedTabIds).toEqual(new Set([PARKED_TAB_ID]))
    expect(getParkedTerminalWatcherTabIds()).toEqual([PARKED_TAB_ID])
    expect(transport.start).toHaveBeenCalledTimes(1)

    const layouts = useAppStore.getState().terminalLayoutsByTabId
    const observations: { parked: boolean; covered: boolean; watcherTabs: string[] }[] = []
    for (let sequence = 2; sequence <= 31; sequence += 1) {
      const verification = sequence % 2 === 0 ? 'unavailable' : 'verified'
      publishStatus(sequence, verification)
      const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(ENVIRONMENT_ID)
      expect(entry?.status === null).toBe(verification === 'unavailable')
      observations.push({
        parked: parkedTabIds.has(PARKED_TAB_ID),
        covered: canWatcherCoverParkedTerminalTab(WORKTREE_ID, TABS[1]),
        watcherTabs: getParkedTerminalWatcherTabIds()
      })
    }

    expect(mounts.get(PARKED_TAB_ID)).toBe(1)
    expect(observations).toEqual(
      Array.from({ length: 30 }, () => ({
        parked: true,
        covered: true,
        watcherTabs: [PARKED_TAB_ID]
      }))
    )
    expect(mounts.get(RETAINED_TAB_ID)).toBe(1)
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]).toBe(TABS)
    expect(useAppStore.getState().terminalLayoutsByTabId).toBe(layouts)
  })
})
