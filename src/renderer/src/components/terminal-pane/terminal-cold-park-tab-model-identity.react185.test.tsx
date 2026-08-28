/** @vitest-environment happy-dom */
/**
 * Crash cluster "React #185 in TerminalPaneOverlayLayer" (boundary terminal.workbench).
 *
 * The overlay's own park verdict does not oscillate (terminal-cold-park-verdict-loop
 * covers that). What used to put it in the stack: its cold-park effect re-runs on
 * every tab-model write — a runtime title publication, an unread bump re-mints
 * tabsByWorktree — and each run dispatched setColdParkedTerminalTabIds even when
 * the verdict was unchanged. React only bails on such a dispatch while the fiber
 * has no pending lanes, so inside a cascade some other component drives, this hook
 * is the one that trips the root-global nested-update counter and gets blamed (see
 * src/shared/react-update-depth-attribution.ts).
 */
import { act, useEffect, useState, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REACT_NESTED_UPDATE_LIMIT } from '../../../../shared/react-update-depth-attribution'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = vi.hoisted(() => ({
  worktreeId: 'repo::/cold-park-tab-model-identity',
  parkEffectRuns: 0,
  renderedParkedSets: [] as string[][]
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

vi.mock('./TerminalOverlaySlot', () => ({ TerminalOverlaySlot: () => null }))

vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => true,
  disposeParkedTerminalWatchersForWorktree: () => {},
  syncParkedTerminalTabWatchers: (args: { parkedTabIds: ReadonlySet<string> }) => {
    harness.renderedParkedSets.push([...args.parkedTabIds].sort())
  }
}))

// Counts cold-park effect executions: the effect clears and re-arms its recheck
// timers on every run, so this is also the per-commit work the identity dep costs.
vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => {
    harness.parkEffectRuns += 1
    return { coldParkDelayMs: 0, hotRetainMs: 0 }
  }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

import { useAppStore } from '../../store'
import TerminalPaneOverlayLayer from './TerminalPaneOverlayLayer'

const TAB_IDS = ['tab-a', 'tab-b'] as const
const GROUP_ID = 'group-a'
/** Above React's nested-update limit so the cascade actually reaches the bail. */
const CASCADE_COMMITS = REACT_NESTED_UPDATE_LIMIT * 2

type ParkingStoreState = {
  groupsByWorktree: Record<string, TabGroup[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
}

const parkingStore = useAppStore as unknown as {
  getState: () => ParkingStoreState
  setState: (partial: unknown) => void
}

function terminalTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: harness.worktreeId,
    ptyId: `${harness.worktreeId}@@session-${id}`,
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
  } as Tab
}

/** An ordinary runtime title publication: re-mints tabsByWorktree, changes no park input. */
function publishRuntimeTitle(revision: number): void {
  parkingStore.setState((state: ParkingStoreState) => ({
    tabsByWorktree: {
      ...state.tabsByWorktree,
      [harness.worktreeId]: state.tabsByWorktree[harness.worktreeId].map((tab) => ({
        ...tab,
        title: `${tab.id}-${revision}`
      }))
    }
  }))
}

/**
 * The cascade driver: a component with its own runaway passive effect, in no way
 * related to terminal parking. It is the bug; the overlay is the bystander.
 */
function UnrelatedCascadeDriver(): null {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (tick >= CASCADE_COMMITS) {
      return
    }
    publishRuntimeTitle(tick)
    setTick((current) => current + 1)
  }, [tick])
  return null
}

function renderTree(root: Root): unknown {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  let error: unknown = null
  try {
    act(() => {
      root.render(
        <StrictMode>
          <TerminalPaneOverlayLayer
            worktreeId={harness.worktreeId}
            worktreePath="cold-park-tab-model-identity"
            isWorktreeActive={false}
            coldParkTerminalPanes={false}
          />
          <UnrelatedCascadeDriver />
        </StrictMode>
      )
    })
  } catch (thrown) {
    error = thrown
  }
  consoleError.mockRestore()
  return error
}

describe('cold-park effect vs. unrelated commit cascade', () => {
  let container: HTMLDivElement
  let root: Root | undefined
  beforeEach(() => {
    harness.parkEffectRuns = 0
    harness.renderedParkedSets.length = 0
    const tabs = TAB_IDS.map(terminalTab)
    const unifiedTabs = TAB_IDS.map(unifiedTerminalTab)
    parkingStore.setState({
      activeGroupIdByWorktree: { [harness.worktreeId]: GROUP_ID },
      groupsByWorktree: {
        [harness.worktreeId]: [
          {
            id: GROUP_ID,
            worktreeId: harness.worktreeId,
            activeTabId: unifiedTabs[0].id,
            tabOrder: unifiedTabs.map((tab) => tab.id),
            recentTabIds: [unifiedTabs[0].id]
          } as TabGroup
        ]
      },
      tabsByWorktree: { [harness.worktreeId]: tabs },
      unifiedTabsByWorktree: { [harness.worktreeId]: unifiedTabs }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    try {
      act(() => root?.unmount())
    } catch {
      /* a failed commit leaves no mounted tree */
    }
    root = undefined
    container.remove()
  })

  it('dispatches no park-state update for tab-model writes that change no park verdict', () => {
    root = createRoot(container)
    const error = renderTree(root)

    // The park verdict itself never churns: one empty -> parked transition,
    // matching the field bundle, which carries no terminal_park_verdict_churn crumb.
    expect(harness.renderedParkedSets.at(-1)).toEqual(['tab-b'])
    expect(new Set(harness.renderedParkedSets.map((ids) => ids.join(',')))).toEqual(
      new Set(['', 'tab-b'])
    )

    // React #185 still fires — the driver is the bug — but it must land on the
    // driver's own dispatch, not on the overlay's park state. Asserting the throw
    // happened keeps the "not blamed" check below from passing on an empty stack.
    expect(error instanceof Error ? error.message : '').toContain('Maximum update depth exceeded')
    const stack = error instanceof Error ? (error.stack ?? '') : String(error ?? '')
    expect(stack).not.toContain('use-terminal-tab-cold-parking')
    expect(stack).toContain('terminal-cold-park-tab-model-identity')
    // The effect itself still re-runs — coverage is re-derived from store state
    // the park key cannot encode — it just stops dispatching an unchanged verdict.
    expect(harness.parkEffectRuns).toBeGreaterThan(REACT_NESTED_UPDATE_LIMIT)
  })
})
