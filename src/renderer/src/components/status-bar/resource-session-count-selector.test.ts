import { describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import {
  buildResourceSessionBindingIndex,
  type ResourceSessionBindingInputs
} from './resource-session-bindings'
import {
  createClosedResourceSessionCountSelector,
  type ClosedResourceSessionCountState
} from './resource-session-count-selector'

const TAB_COUNT = 100
const TITLE_WRITES = 600

function makeTab(id: string, ptyId: string | null = null, title = 'Terminal'): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: `wt-${id}`,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeLayout(ptyIdsByLeafId: Record<string, string>): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: 'leaf-1' },
    activeLeafId: 'leaf-1',
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function makeState(
  overrides: Partial<ClosedResourceSessionCountState> = {}
): ClosedResourceSessionCountState {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    workspaceSessionReady: true,
    ...overrides
  }
}

function withCountedIteration(tabs: TerminalTab[], onVisit: () => void): TerminalTab[] {
  return new Proxy(tabs, {
    get(target, property, receiver) {
      if (property !== Symbol.iterator) {
        return Reflect.get(target, property, receiver)
      }
      return function* countedIterator(): Generator<TerminalTab> {
        for (const tab of target) {
          onVisit()
          yield tab
        }
      }
    }
  })
}

function makeScaleTabs(onVisit: () => void): Record<string, TerminalTab[]> {
  return Object.fromEntries(
    Array.from({ length: TAB_COUNT }, (_, index) => {
      const worktreeId = `wt-${index}`
      return [worktreeId, withCountedIteration([makeTab(`tab-${index}`, `pty-${index}`)], onVisit)]
    })
  )
}

function countNextTabComparison(
  tab: TerminalTab,
  onComparison: () => void
): [TerminalTab[], () => void] {
  let counting = true
  const tabs = new Proxy([tab], {
    get(target, property, receiver) {
      if (counting && property === '0') {
        onComparison()
      }
      return Reflect.get(target, property, receiver)
    }
  })
  return [
    tabs,
    () => {
      counting = false
    }
  ]
}

describe('closed resource session count selector', () => {
  it('removes full binding-index rebuilds from title-only tab churn at scale', () => {
    let oldPathTabVisits = 0
    const initialTabs = makeScaleTabs(() => {
      oldPathTabVisits += 1
    })
    const inputs: ResourceSessionBindingInputs = {
      tabsByWorktree: initialTabs,
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      workspaceSessionReady: true
    }

    // Why: this models the previous useMemo dependency on tabsByWorktree:
    // every title write replaces that map and rebuilds both tab passes.
    for (let index = 0; index < TITLE_WRITES; index += 1) {
      buildResourceSessionBindingIndex({ ...inputs, tabsByWorktree: { ...initialTabs } })
    }
    expect(oldPathTabVisits).toBe(120_000)

    let optimizedTabVisits = 0
    const optimizedTabs = makeScaleTabs(() => {
      optimizedTabVisits += 1
    })
    const buildIndex = vi.fn(buildResourceSessionBindingIndex)
    const selectCount = createClosedResourceSessionCountSelector(buildIndex)
    let state = makeState({ tabsByWorktree: optimizedTabs })
    const currentTabByWorktree = Object.fromEntries(
      Object.entries(optimizedTabs).map(([worktreeId, tabs]) => [worktreeId, tabs[0]])
    )
    let changedArrayTabComparisons = 0

    expect(selectCount(state)).toBe(TAB_COUNT)
    buildIndex.mockClear()
    optimizedTabVisits = 0

    for (let index = 0; index < TITLE_WRITES; index += 1) {
      const worktreeId = `wt-${index % TAB_COUNT}`
      const nextTab = { ...currentTabByWorktree[worktreeId], title: `Terminal ${index}` }
      const [nextTabs, stopCounting] = countNextTabComparison(nextTab, () => {
        changedArrayTabComparisons += 1
      })
      state = {
        ...state,
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [worktreeId]: nextTabs
        }
      }
      expect(selectCount(state)).toBe(TAB_COUNT)
      stopCounting()
      currentTabByWorktree[worktreeId] = nextTab
    }

    expect(buildIndex).not.toHaveBeenCalled()
    expect(optimizedTabVisits).toBe(0)
    expect(changedArrayTabComparisons).toBe(TITLE_WRITES)
  })

  it('reacts to every binding and readiness input while ignoring display-only tab fields', () => {
    const buildIndex = vi.fn(buildResourceSessionBindingIndex)
    const selectCount = createClosedResourceSessionCountSelector(buildIndex)
    let state = makeState({
      workspaceSessionReady: false,
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'pty-wake')]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-live']
      },
      terminalLayoutsByTabId: {
        'tab-1': makeLayout({ 'leaf-1': 'pty-layout' })
      }
    })

    expect(selectCount(state)).toBe(0)
    expect(buildIndex).not.toHaveBeenCalled()

    state = { ...state, workspaceSessionReady: true }
    expect(selectCount(state)).toBe(3)
    expect(buildIndex).toHaveBeenCalledTimes(1)

    state = {
      ...state,
      tabsByWorktree: {
        'wt-1': [{ ...state.tabsByWorktree['wt-1'][0], title: 'Working' }]
      }
    }
    expect(selectCount(state)).toBe(3)
    expect(buildIndex).toHaveBeenCalledTimes(1)

    state = {
      ...state,
      ptyIdsByTabId: { 'tab-1': ['pty-live', 'pty-live-2'] }
    }
    expect(selectCount(state)).toBe(4)
    expect(buildIndex).toHaveBeenCalledTimes(2)

    state = {
      ...state,
      terminalLayoutsByTabId: {
        'tab-1': makeLayout({ 'leaf-1': 'pty-layout', 'leaf-2': 'pty-layout-2' })
      }
    }
    expect(selectCount(state)).toBe(5)
    expect(buildIndex).toHaveBeenCalledTimes(3)

    state = {
      ...state,
      tabsByWorktree: {
        'wt-1': [{ ...state.tabsByWorktree['wt-1'][0], ptyId: null }]
      }
    }
    expect(selectCount(state)).toBe(4)
    expect(buildIndex).toHaveBeenCalledTimes(4)

    state = { ...state, tabsByWorktree: {} }
    expect(selectCount(state)).toBe(2)
    expect(buildIndex).toHaveBeenCalledTimes(5)

    state = { ...state, workspaceSessionReady: false }
    expect(selectCount(state)).toBe(0)
    expect(buildIndex).toHaveBeenCalledTimes(5)
  })
})
