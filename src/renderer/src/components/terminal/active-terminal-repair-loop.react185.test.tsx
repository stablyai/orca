/** @vitest-environment happy-dom */
import { act } from 'react'

import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab, TabGroup } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('active-terminal repair effect cannot drive a React #185 update loop', () => {
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
