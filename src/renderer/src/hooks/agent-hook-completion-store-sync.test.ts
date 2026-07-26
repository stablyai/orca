import { describe, expect, it } from 'vitest'
import {
  _measureAgentHookCompletionStoreSyncForTest,
  shouldSyncAgentHookCompletionForStoreUpdate,
  type AgentHookCompletionStoreSnapshot
} from './agent-hook-completion-store-sync'

function createState(
  overrides: Partial<AgentHookCompletionStoreSnapshot> = {}
): AgentHookCompletionStoreSnapshot {
  return {
    settings: {
      experimentalTerminalAttention: false,
      notifications: { enabled: true, agentTaskComplete: true }
    },
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', title: 'Terminal 1' }]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    terminalLayoutsByTabId: {},
    suppressedPtyExitIds: {},
    ...overrides
  }
}

describe('agent hook completion store sync', () => {
  it('ignores unrelated and title-only writes at accumulated-workspace scale', () => {
    const tabCount = 100
    const coordinatorCount = 100
    const updateCount = 600
    const tabsByWorktree = Object.fromEntries(
      Array.from({ length: tabCount }, (_, index) => [
        `wt-${index}`,
        [{ id: `tab-${index}`, ptyId: `pty-${index}`, title: `Terminal ${index}` }]
      ])
    )
    let previous = createState({ tabsByWorktree })
    let syncPasses = 0
    let tabVisits = 0

    for (let index = 0; index < updateCount; index += 1) {
      const current = { ...previous }
      const measurement = _measureAgentHookCompletionStoreSyncForTest(current, previous)
      syncPasses += Number(measurement.shouldSync)
      tabVisits += measurement.tabVisits
      previous = current
    }

    for (let index = 0; index < updateCount; index += 1) {
      const targetTabs = previous.tabsByWorktree['wt-99']
      if (!targetTabs) {
        throw new Error('Expected title-update fixture tab')
      }
      const current = createState({
        ...previous,
        tabsByWorktree: {
          ...previous.tabsByWorktree,
          'wt-99': targetTabs.map((tab) => ({ ...tab, title: `Agent frame ${index}` }))
        }
      })
      const measurement = _measureAgentHookCompletionStoreSyncForTest(current, previous)
      syncPasses += Number(measurement.shouldSync)
      tabVisits += measurement.tabVisits
      previous = current
    }

    const previousFullPassCost = {
      tabVisits: updateCount * 2 * tabCount,
      coordinatorVisits: updateCount * 2 * coordinatorCount
    }
    const gatedCost = {
      tabVisits,
      coordinatorVisits: syncPasses * coordinatorCount
    }
    expect(previousFullPassCost).toEqual({ tabVisits: 120_000, coordinatorVisits: 120_000 })
    expect(gatedCost).toEqual({ tabVisits: 600, coordinatorVisits: 0 })
  })

  it('keeps every coordinator-liveness input reactive', () => {
    const previous = createState()
    const titleOnly = createState({
      ...previous,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', title: 'Codex working' }]
      }
    })
    expect(shouldSyncAgentHookCompletionForStoreUpdate(titleOnly, previous)).toBe(false)

    const tabCreated = createState({
      ...previous,
      tabsByWorktree: {
        ...previous.tabsByWorktree,
        'wt-2': [{ id: 'tab-2', ptyId: null }]
      }
    })
    expect(shouldSyncAgentHookCompletionForStoreUpdate(tabCreated, previous)).toBe(true)

    const tabRemoved = createState({ ...previous, tabsByWorktree: {} })
    expect(shouldSyncAgentHookCompletionForStoreUpdate(tabRemoved, previous)).toBe(true)

    const tabPtyChanged = createState({
      ...previous,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-2' }] }
    })
    expect(shouldSyncAgentHookCompletionForStoreUpdate(tabPtyChanged, previous)).toBe(true)

    expect(
      shouldSyncAgentHookCompletionForStoreUpdate(
        createState({ ...previous, ptyIdsByTabId: { 'tab-1': ['pty-2'] } }),
        previous
      )
    ).toBe(true)
    expect(
      shouldSyncAgentHookCompletionForStoreUpdate(
        createState({ ...previous, terminalLayoutsByTabId: { 'tab-1': { root: null } } }),
        previous
      )
    ).toBe(true)
    expect(
      shouldSyncAgentHookCompletionForStoreUpdate(
        createState({ ...previous, suppressedPtyExitIds: { 'pty-1': true } }),
        previous
      )
    ).toBe(true)

    const trackingDisabled = createState({
      ...previous,
      settings: {
        experimentalTerminalAttention: false,
        notifications: { enabled: false, agentTaskComplete: false }
      }
    })
    expect(shouldSyncAgentHookCompletionForStoreUpdate(trackingDisabled, previous)).toBe(true)
  })

  it('treats tab order and duplicate-id worktree precedence as liveness inputs', () => {
    const previous = createState({
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-shared', ptyId: 'pty-first' }],
        'wt-2': [{ id: 'tab-shared', ptyId: 'pty-second' }]
      }
    })
    const reorderedWorktrees = createState({
      ...previous,
      tabsByWorktree: {
        'wt-2': previous.tabsByWorktree['wt-2'] ?? [],
        'wt-1': previous.tabsByWorktree['wt-1'] ?? []
      }
    })
    expect(shouldSyncAgentHookCompletionForStoreUpdate(reorderedWorktrees, previous)).toBe(true)

    const twoTabPrevious = createState({
      tabsByWorktree: {
        'wt-1': [
          { id: 'tab-1', ptyId: 'pty-1' },
          { id: 'tab-2', ptyId: 'pty-2' }
        ]
      }
    })
    const reorderedTabs = createState({
      ...twoTabPrevious,
      tabsByWorktree: {
        'wt-1': [
          { id: 'tab-2', ptyId: 'pty-2' },
          { id: 'tab-1', ptyId: 'pty-1' }
        ]
      }
    })
    expect(shouldSyncAgentHookCompletionForStoreUpdate(reorderedTabs, twoTabPrevious)).toBe(true)
  })

  it('compares effective tracking state instead of unrelated settings identity', () => {
    const previous = createState({
      settings: {
        experimentalTerminalAttention: true,
        notifications: { enabled: false, agentTaskComplete: false }
      }
    })
    const stillTrackedByNotifications = createState({
      ...previous,
      settings: {
        experimentalTerminalAttention: false,
        notifications: { enabled: true, agentTaskComplete: true }
      }
    })
    expect(shouldSyncAgentHookCompletionForStoreUpdate(stillTrackedByNotifications, previous)).toBe(
      false
    )
  })
})
