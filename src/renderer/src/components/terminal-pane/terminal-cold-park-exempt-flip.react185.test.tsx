/**
 * Guard for the capability re-settlement fix: eviction-exemption flips are a
 * pin-unreachable input to the rendered park verdict (same family as the
 * activation-deferred clause behind the terminal.workbench React #185
 * cluster). Capability verdicts may therefore only change between commits —
 * asynchronously, off daemon answers — never as a function of the pane
 * mount/unmount lifecycle. This harness force-parks a worktree, lets pane
 * mounts write layouts/titles (the mount-lifecycle writes that feed the
 * exemption's OTHER inputs), and flips the capability verdict between commits
 * repeatedly: every flip must settle without approaching React's nested
 * update limit.
 */
/** @vitest-environment happy-dom */
import { act, StrictMode } from 'react'
import type * as ReactModule from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type * as ParkedTabWatchersModule from './terminal-parked-tab-watchers'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = vi.hoisted(() => ({
  worktreeId: 'wt-exempt-flip',
  syncCalls: 0,
  slotRenders: 0,
  slotMounts: 0,
  observedParkedCounts: new Set<number>(),
  watcherEntries: new Set<string>()
}))

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    activeGroupIdByWorktree: {} as Record<string, string | undefined>,
    groupsByWorktree: {} as Record<string, TabGroup[]>,
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map<string, unknown>(),
    runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
    settings: {} as Record<string, unknown>,
    sleepingAgentSessionsByPaneKey: {} as Record<string, unknown>,
    tabsByWorktree: {} as Record<string, TerminalTab[]>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    unifiedTabsByWorktree: {} as Record<string, Tab[]>,
    consumeSuppressedPtyExit: () => false,
    focusGroup: () => {},
    reconcileWorktreeTabModel: () => ({ renderableTabCount: 2 }),
    setActiveWorktree: () => {}
  }))
  return { useAppStore }
})

vi.mock('../native-chat/use-native-chat-toggle-shortcut', () => ({
  useNativeChatToggleShortcut: () => {}
}))

vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => ({})
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: () => {}
}))

// Why mount writes: a revealing pane publishes its title and registers its
// layout leaf — the mount-lifecycle writes that feed the exemption's layout
// key. The capability verdict itself must stay untouched by these.
vi.mock('./TerminalOverlaySlot', async () => {
  const { useEffect } = await vi.importActual<typeof ReactModule>('react')
  const { useAppStore } = await import('../../store')
  type SlotStoreState = {
    tabsByWorktree: Record<string, TerminalTab[]>
    terminalLayoutsByTabId: Record<string, unknown>
  }
  return {
    TerminalOverlaySlot: ({ terminalTabId }: { terminalTabId: string }) => {
      harness.slotRenders += 1
      useEffect(() => {
        harness.slotMounts += 1
        if (harness.slotMounts > 400) {
          throw new Error('harness runaway: slot remount storm exceeded 400 mounts')
        }
        ;(
          useAppStore as unknown as {
            setState: (update: (state: SlotStoreState) => Partial<SlotStoreState>) => void
          }
        ).setState((state) => ({
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [harness.worktreeId]: state.tabsByWorktree[harness.worktreeId].map((tab) =>
              tab.id === terminalTabId ? { ...tab, title: `mounted-${harness.slotMounts}` } : tab
            )
          },
          terminalLayoutsByTabId: { ...state.terminalLayoutsByTabId }
        }))
      }, [terminalTabId])
      return null
    }
  }
})

vi.mock('./terminal-parked-tab-watchers', async () => {
  const actual = await vi.importActual<typeof ParkedTabWatchersModule>(
    './terminal-parked-tab-watchers'
  )
  return {
    ...actual,
    syncParkedTerminalTabWatchers: (args: {
      tabs: readonly { id: string }[]
      parkedTabIds: ReadonlySet<string>
    }) => {
      harness.syncCalls += 1
      if (harness.syncCalls > 400) {
        throw new Error('harness runaway: watcher sync exceeded 400 reconciliations')
      }
      harness.observedParkedCounts.add(args.parkedTabIds.size)
      for (const tabId of Array.from(harness.watcherEntries)) {
        if (!args.parkedTabIds.has(tabId)) {
          harness.watcherEntries.delete(tabId)
        }
      }
      for (const tab of args.tabs) {
        if (args.parkedTabIds.has(tab.id)) {
          harness.watcherEntries.add(tab.id)
        }
      }
    },
    disposeParkedTerminalWatchersForWorktree: () => {
      harness.watcherEntries.clear()
    }
  }
})

import { useAppStore } from '../../store'
import TerminalPaneOverlayLayer from './TerminalPaneOverlayLayer'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'

const TAB_IDS = ['tab-a', 'tab-b'] as const
const GROUP_ID = 'group-a'
const LEAF_IDS: Record<string, string> = {
  'tab-a': '11111111-2222-4333-8444-55555555555a',
  'tab-b': '11111111-2222-4333-8444-55555555555b'
}

const harnessStore = useAppStore as unknown as {
  setState: (partial: Record<string, unknown>) => void
  getState: () => { tabsByWorktree: Record<string, TerminalTab[]> }
}

function ptyIdFor(tabId: string): string {
  return `${harness.worktreeId}@@session-${tabId}`
}

function terminalTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: harness.worktreeId,
    ptyId: ptyIdFor(id),
    title: id,
    generation: 0
  } as TerminalTab
}

function unifiedTerminalTab(id: string): Tab {
  return {
    id: `unified-${id}`,
    entityId: id,
    worktreeId: harness.worktreeId,
    groupId: GROUP_ID,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

// Why the store touch: capability answers land in module state, which the
// exemption memo cannot subscribe to; the next store change reveals them —
// modeled here as the routine title churn every live session produces.
function touchStoreTitles(marker: string): void {
  harnessStore.setState({
    tabsByWorktree: {
      [harness.worktreeId]: harnessStore
        .getState()
        .tabsByWorktree[harness.worktreeId].map((tab) => ({
          ...tab,
          title: `${tab.id}-${marker}`
        }))
    }
  })
}

describe('force-park exemption flips under capability changes', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    clearTerminalProviderSnapshotCapabilities()
    harness.syncCalls = 0
    harness.slotRenders = 0
    harness.slotMounts = 0
    harness.observedParkedCounts.clear()
    harness.watcherEntries.clear()
    harnessStore.setState({
      activeGroupIdByWorktree: { [harness.worktreeId]: GROUP_ID },
      groupsByWorktree: {
        [harness.worktreeId]: [
          {
            id: GROUP_ID,
            worktreeId: harness.worktreeId,
            activeTabId: `unified-${TAB_IDS[0]}`,
            tabOrder: TAB_IDS.map((id) => `unified-${id}`),
            recentTabIds: [`unified-${TAB_IDS[0]}`]
          }
        ]
      },
      tabsByWorktree: { [harness.worktreeId]: TAB_IDS.map(terminalTab) },
      unifiedTabsByWorktree: { [harness.worktreeId]: TAB_IDS.map(unifiedTerminalTab) },
      terminalLayoutsByTabId: Object.fromEntries(
        TAB_IDS.map((id) => [
          id,
          {
            root: { type: 'leaf', leafId: LEAF_IDS[id] },
            activeLeafId: LEAF_IDS[id],
            ptyIdsByLeafId: { [LEAF_IDS[id]]: ptyIdFor(id) }
          }
        ])
      )
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    try {
      act(() => root?.unmount())
    } catch {
      // A failed commit leaves no mounted tree to clean up.
    }
    root = undefined
    container.remove()
    clearTerminalProviderSnapshotCapabilities()
  })

  it('settles every capability flip without approaching the update-depth limit', async () => {
    root = createRoot(container)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let thrown: unknown = null
    try {
      act(() => {
        root!.render(
          <StrictMode>
            <TerminalPaneOverlayLayer
              worktreeId={harness.worktreeId}
              worktreePath="exempt-flip"
              isWorktreeActive={false}
              coldParkTerminalPanes={true}
              isForceParked={true}
            />
          </StrictMode>
        )
      })

      const allPtyIds = TAB_IDS.map(ptyIdFor)
      for (let flip = 0; flip < 6; flip += 1) {
        const syncCallsBefore = harness.syncCalls
        await act(async () => {
          if (flip % 2 === 0) {
            // Daemon answered: every pty has an authoritative snapshot.
            await synchronizeTerminalProviderSnapshotCapabilities(
              [...allPtyIds],
              async (ids) => ids.map((id) => ({ id, authoritative: true })),
              1_000 + flip
            )
          } else {
            // Daemon restart: verdicts reset to unknown (exempt again).
            clearTerminalProviderSnapshotCapabilities()
          }
          touchStoreTitles(`flip-${flip}`)
        })
        expect(harness.syncCalls - syncCallsBefore).toBeLessThan(20)
      }
    } catch (error) {
      thrown = error
    }
    consoleError.mockRestore()

    expect(thrown).toBeNull()
    // Non-vacuous: the flips genuinely moved the rendered verdict both ways —
    // all-exempt (0 parked) and all-evictable (2 parked) were both committed.
    expect(harness.observedParkedCounts.has(0)).toBe(true)
    expect(harness.observedParkedCounts.has(TAB_IDS.length)).toBe(true)
    expect(harness.slotMounts).toBeGreaterThan(0)
  })
})
