/** @vitest-environment happy-dom */
import { act, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useActiveTerminalRepair } from './use-active-terminal-repair'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Why: React throws #185 at 51 nested commits; 400 proves divergence, not slowness.
const MAX_PASSES = 400

function terminalTab(id: string, worktreeId: string): TerminalTab {
  return { id, worktreeId, title: id, createdAt: 0, sortOrder: 0 } as unknown as TerminalTab
}

function unifiedTerminalTab(
  id: string,
  entityId: string,
  worktreeId: string,
  groupId: string
): Tab {
  return {
    id,
    entityId,
    worktreeId,
    groupId,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function tabGroup(
  id: string,
  worktreeId: string,
  activeTabId: string,
  tabOrder: string[]
): TabGroup {
  return { id, worktreeId, activeTabId, tabOrder, recentTabIds: [activeTabId] }
}

function RepairEffectHarness(): null {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeTabIdByWorktree = useAppStore((s) => s.activeTabIdByWorktree)
  const activeTabType = useAppStore((s) => s.activeTabType)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const renderedActiveWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const tabs = useMemo(
    () =>
      renderedActiveWorktreeId !== null && Object.hasOwn(tabsByWorktree, renderedActiveWorktreeId)
        ? tabsByWorktree[renderedActiveWorktreeId]
        : [],
    [renderedActiveWorktreeId, tabsByWorktree]
  )

  useActiveTerminalRepair({
    activeTabId,
    activeTabType,
    setActiveTab,
    tabs,
    activeTabIdByWorktree,
    renderedActiveWorktreeId
  })
  return null
}

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

function measureRepairPasses(): number {
  let passes = 0
  const setActiveTab = useAppStore.getState().setActiveTab
  useAppStore.setState({
    setActiveTab: (tabId) => {
      passes += 1
      if (passes <= MAX_PASSES) {
        setActiveTab(tabId)
      }
    }
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  cleanup = () => {
    act(() => root.unmount())
    useAppStore.setState({ setActiveTab })
    container.remove()
  }
  act(() => {
    root.render(<RepairEffectHarness />)
  })
  return passes
}

describe('active-terminal repair effect cannot drive a React #185 update loop', () => {
  it('settles when the repaired tab is owned by the active worktree', () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      activeTabType: 'terminal',
      activeTabId: 'stale-tab',
      activeTabIdByWorktree: {},
      tabsByWorktree: { 'wt-active': [terminalTab('t1', 'wt-active')] },
      unifiedTabsByWorktree: {}
    })
    expect(measureRepairPasses()).toBeLessThan(10)
    expect(useAppStore.getState().activeTabId).toBe('t1')
  })

  it('settles when another worktree reuses the tab id and is scanned first', () => {
    // Why regression: first-match ownership skipped activeTabId while reallocating
    // activeTabIdByWorktree, retriggering the repair effect indefinitely.
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      activeTabType: 'terminal',
      activeTabId: 'stale-tab',
      activeTabIdByWorktree: {},
      tabsByWorktree: {
        'wt-other': [terminalTab('t1', 'wt-other')],
        'wt-active': [terminalTab('t1', 'wt-active')]
      },
      unifiedTabsByWorktree: {}
    })
    expect(measureRepairPasses()).toBeLessThan(10)
    // Why: settling by refusing to write would leave the repair permanently
    // unsatisfied — quiet, but with activeTabId stuck on a tab that is gone.
    expect(useAppStore.getState().activeTabId).toBe('t1')
    expect(useAppStore.getState().activeTabIdByWorktree['wt-active']).toBe('t1')
  })

  it('activates the active worktree unified tab when another worktree reuses the entity id', () => {
    const otherTab = unifiedTerminalTab('t1', 't1', 'wt-other', 'g-other')
    const otherPreviousTab = unifiedTerminalTab(
      'other-previous',
      'other-previous',
      'wt-other',
      'g-other'
    )
    const activeTab = unifiedTerminalTab('t1', 't1', 'wt-active', 'g-active')
    const previousActiveTab = unifiedTerminalTab('u-previous', 't2', 'wt-active', 'g-active')
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      activeTabId: 't2',
      activeTabIdByWorktree: { 'wt-active': 't2' },
      tabsByWorktree: {
        'wt-other': [terminalTab('t1', 'wt-other')],
        'wt-active': [terminalTab('t1', 'wt-active'), terminalTab('t2', 'wt-active')]
      },
      unifiedTabsByWorktree: {
        'wt-other': [otherTab, otherPreviousTab],
        'wt-active': [activeTab, previousActiveTab]
      },
      groupsByWorktree: {
        'wt-other': [
          tabGroup('g-other', 'wt-other', otherPreviousTab.id, [otherTab.id, otherPreviousTab.id])
        ],
        'wt-active': [
          tabGroup('g-active', 'wt-active', previousActiveTab.id, [
            activeTab.id,
            previousActiveTab.id
          ])
        ]
      },
      activeGroupIdByWorktree: { 'wt-other': 'g-other', 'wt-active': 'g-active' }
    })

    act(() => {
      useAppStore.getState().setActiveTab('t1')
    })

    expect(useAppStore.getState().groupsByWorktree['wt-active'][0].activeTabId).toBe(activeTab.id)
    expect(useAppStore.getState().groupsByWorktree['wt-other'][0].activeTabId).toBe(
      otherPreviousTab.id
    )
  })

  it('keeps unified-only terminal activation as a fallback', () => {
    const targetTab = unifiedTerminalTab('u-target', 't1', 'wt-active', 'g-active')
    const previousTab = unifiedTerminalTab('u-previous', 't2', 'wt-active', 'g-active')
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      activeTabId: null,
      activeTabIdByWorktree: {},
      tabsByWorktree: {},
      unifiedTabsByWorktree: { 'wt-active': [targetTab, previousTab] },
      groupsByWorktree: {
        'wt-active': [
          tabGroup('g-active', 'wt-active', previousTab.id, [targetTab.id, previousTab.id])
        ]
      },
      activeGroupIdByWorktree: { 'wt-active': 'g-active' }
    })

    act(() => {
      useAppStore.getState().setActiveTab('t1')
    })

    expect(useAppStore.getState().groupsByWorktree['wt-active'][0].activeTabId).toBe(targetTab.id)
    expect(useAppStore.getState().activeTabId).toBeNull()
  })

  it('does not reallocate activeTabIdByWorktree when the tab is already active', () => {
    // Why: that map is a dependency of both the repair effect and the parked
    // watcher sync, so a redundant activation must not re-run either.
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      activeTabType: 'terminal',
      activeTabId: 't1',
      activeTabIdByWorktree: {},
      tabsByWorktree: { 'wt-active': [terminalTab('t1', 'wt-active')] },
      unifiedTabsByWorktree: {}
    })
    act(() => {
      useAppStore.getState().setActiveTab('t1')
    })
    const settled = useAppStore.getState().activeTabIdByWorktree
    act(() => {
      useAppStore.getState().setActiveTab('t1')
    })
    expect(useAppStore.getState().activeTabIdByWorktree).toBe(settled)
  })

  it('keeps bell attribution off a background worktree tab', () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      activeTabType: 'terminal',
      activeTabId: 'visible-tab',
      activeTabIdByWorktree: {},
      tabsByWorktree: {
        'wt-active': [terminalTab('visible-tab', 'wt-active')],
        'wt-background': [terminalTab('bg-tab', 'wt-background')]
      },
      unifiedTabsByWorktree: {}
    })
    act(() => {
      useAppStore.getState().setActiveTab('bg-tab')
    })
    expect(useAppStore.getState().activeTabId).toBe('visible-tab')
    expect(useAppStore.getState().activeTabIdByWorktree['wt-background']).toBe('bg-tab')
  })

  it('records activation for a falsy-but-valid worktree id', () => {
    useAppStore.setState({
      activeWorktreeId: '',
      activeTabId: null,
      activeTabIdByWorktree: {},
      tabsByWorktree: { '': [terminalTab('t1', '')] },
      unifiedTabsByWorktree: {}
    })
    act(() => {
      useAppStore.getState().setActiveTab('t1')
    })
    expect(useAppStore.getState().activeTabId).toBe('t1')
    expect(useAppStore.getState().activeTabIdByWorktree['']).toBe('t1')
  })

  it('repairs a falsy-but-valid active worktree id through the production hook', () => {
    useAppStore.setState({
      activeWorktreeId: '',
      activeTabType: 'terminal',
      activeTabId: 'stale-tab',
      activeTabIdByWorktree: { '': 't1' },
      tabsByWorktree: { '': [terminalTab('t1', '')] },
      unifiedTabsByWorktree: {}
    })
    expect(measureRepairPasses()).toBeLessThan(10)
    expect(useAppStore.getState().activeTabId).toBe('t1')
  })

  it('does not read inherited unified tabs for a prototype-named owner', () => {
    useAppStore.setState({
      activeWorktreeId: 'toString',
      activeTabId: null,
      activeTabIdByWorktree: {},
      tabsByWorktree: { toString: [terminalTab('t1', 'toString')] },
      unifiedTabsByWorktree: {}
    })
    expect(() => useAppStore.getState().setActiveTab('t1')).not.toThrow()
    expect(useAppStore.getState().activeTabId).toBe('t1')
  })

  it('activates own unified tabs for a prototype-named owner', () => {
    const target = unifiedTerminalTab('t1', 't1', 'toString', 'g-target')
    const previous = unifiedTerminalTab('t2', 't2', 'toString', 'g-target')
    useAppStore.setState({
      activeWorktreeId: 'toString',
      activeTabId: 't2',
      activeTabIdByWorktree: { toString: 't2' },
      tabsByWorktree: {
        toString: [terminalTab('t1', 'toString'), terminalTab('t2', 'toString')]
      },
      unifiedTabsByWorktree: { toString: [target, previous] },
      groupsByWorktree: {
        toString: [tabGroup('g-target', 'toString', previous.id, [target.id, previous.id])]
      },
      activeGroupIdByWorktree: { toString: 'g-target' }
    })
    act(() => useAppStore.getState().setActiveTab('t1'))
    expect(useAppStore.getState().groupsByWorktree.toString[0].activeTabId).toBe(target.id)
  })

  it('does not activate a tab with no owner when no worktree is active', () => {
    useAppStore.setState({
      activeWorktreeId: null,
      activeTabId: null,
      activeTabIdByWorktree: {},
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      unreadTerminalTabs: { 'missing-tab': true }
    })
    act(() => {
      useAppStore.getState().setActiveTab('missing-tab')
    })
    expect(useAppStore.getState().activeTabId).toBeNull()
    expect(useAppStore.getState().activeTabIdByWorktree).toEqual({})
    expect(useAppStore.getState().unreadTerminalTabs['missing-tab']).toBe(true)
  })
})
