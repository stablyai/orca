import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../src/main/runtime/orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { getDefaultWorkspaceSession } from '../../../src/shared/constants'
import {
  TEST_WORKTREE_ID as WT,
  makeRuntimeStoreWithWorkspaceSession
} from '../../../src/main/runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTabGroup
} from '../../../src/shared/runtime-session-contracts'
import { normalizeMobileSessionTabSelection } from '../../../src/main/runtime/session-tabs/mobile-session-tab-selection'
import { finalizeRuntimeMobileSessionTabsResult } from '../../../src/main/runtime/session-lifecycle/projection/runtime-mobile-session-result-finalization'

function counted<T>(rows: T[]) {
  let visits = 0
  const observed = [...rows]
  rows.forEach((row, index) => {
    Object.defineProperty(observed, index, {
      get() {
        visits++
        return row
      }
    })
  })
  return {
    rows: observed,
    visits: () => visits,
    reset: () => {
      visits = 0
    }
  }
}

function frame(count: number, version = 1, worktree = WT): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer:selection-scale',
    snapshotVersion: version,
    activeGroupId: `g-${count - 1}`,
    activeTabId: `t-${count - 1}::leaf`,
    activeTabType: 'terminal',
    tabGroups: Array.from({ length: count }, (_, index) => ({
      id: `g-${index}`,
      activeTabId: `t-${index}`,
      tabOrder: [`t-${index}`]
    })),
    tabs: Array.from({ length: count }, (_, index) => ({
      type: 'terminal',
      id: `t-${index}::leaf`,
      parentTabId: `t-${index}`,
      leafId: 'leaf',
      title: 'Terminal',
      isActive: index === count - 1
    }))
  }
}

afterEach(() => vi.useRealTimers())

describe('active-tab selection performance contract', () => {
  it('bounds selection input visits at 50 and 500 rows, including unavailable-target projection', () => {
    const measurements: number[] = []
    for (const count of [50, 500]) {
      const input = frame(count)
      const rows = counted(
        input.tabs
          .filter((tab) => tab.type === 'terminal')
          .map((tab) => ({
            ...tab,
            status: 'pending-handle' as const,
            terminal: null
          }))
      )
      const groups = counted<RuntimeMobileSessionTabGroup>(input.tabGroups ?? [])
      const snapshot = { ...input, tabs: rows.rows, tabGroups: groups.rows }
      expect(normalizeMobileSessionTabSelection(snapshot)).toBe(snapshot)
      // Resolve + flags: two row scans; group lookup is one scan.
      expect(rows.visits()).toBeLessThanOrEqual(2 * count)
      expect(groups.visits()).toBeLessThanOrEqual(count)
      rows.reset()
      groups.reset()
      const projected = finalizeRuntimeMobileSessionTabsResult(
        { snapshot, tabs: rows.rows },
        {
          sanitizeGroups: () => undefined,
          pruneGroupLayout: () => null,
          collectTabIds: (tabs) => new Set(tabs.map((tab) => tab.id))
        }
      )
      expect(projected.activeTabId).toBe(`t-${count - 1}::leaf`)
      // Final selection adds one scan; a needed flag repair may add one linear copy.
      expect(rows.visits()).toBeLessThanOrEqual(4 * count)
      expect(groups.visits()).toBeLessThanOrEqual(count)
      measurements.push(rows.visits() + groups.visits())
      const missing = {
        ...snapshot,
        tabGroups: [
          {
            id: snapshot.activeGroupId!,
            activeTabId: 'agent-session:pending',
            tabOrder: ['agent-session:pending']
          }
        ]
      }
      rows.reset()
      const unavailable = finalizeRuntimeMobileSessionTabsResult(
        { snapshot: missing, tabs: rows.rows },
        {
          sanitizeGroups: () => undefined,
          pruneGroupLayout: () => null,
          collectTabIds: (tabs) => new Set(tabs.map((tab) => tab.id))
        }
      )
      expect(unavailable.activeTabId).toBeNull()
      expect(unavailable.tabs.some((tab) => tab.isActive)).toBe(false)
      expect(rows.visits()).toBeLessThanOrEqual(4 * count)
    }
    expect(measurements[1]).toBeLessThanOrEqual(10 * measurements[0]!)
  })

  it('keeps publication scoped to a changed worktree and shared by listeners at N and 10N', async () => {
    vi.useFakeTimers()
    for (const count of [50, 500]) {
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
      const runtime = new OrcaRuntimeService(runtimeStore)
      runtime.attachWindow(1)
      const other = `${WT}-unaffected`
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [frame(count), frame(count, 1, other)]
      })
      await vi.runAllTimersAsync()
      const unaffected = runtime.mobileSessionTabsByWorktree.get(other)
      const seen: string[][] = [[], [], []]
      const off = seen.map((events) =>
        runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot.worktree))
      )
      const changed = frame(count, 2)
      changed.activeGroupId = 'g-0'
      changed.activeTabId = 't-0::leaf'
      changed.tabs = changed.tabs.map((tab, index) => ({ ...tab, isActive: index === 0 }))
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [changed],
        unchangedMobileSessionWorktrees: [other]
      })
      await vi.runAllTimersAsync()
      expect(seen).toEqual([[WT], [WT], [WT]])
      const stored = runtime.mobileSessionTabsByWorktree.get(WT)
      expect(stored?.activeTabId).toBe('t-0::leaf')
      expect(stored?.tabs).toBe(changed.tabs)
      expect(stored?.tabGroups).toBe(changed.tabGroups)
      expect(runtime.mobileSessionTabsByWorktree.get(other)).toBe(unaffected)
      seen.forEach((events) => (events.length = 0))
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [changed],
        unchangedMobileSessionWorktrees: [other]
      })
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [],
        unchangedMobileSessionWorktrees: [WT, other]
      })
      runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
      await vi.runAllTimersAsync()
      expect(runtime.mobileSessionTabsByWorktree.get(WT)).toBe(stored)
      expect(seen).toEqual([[], [], []])
      const chat = {
        workspaceId: WT,
        sessionId: 'scale-chat',
        agent: 'codex' as const,
        activate: false
      }
      await runtime.publishStructuredAgentSessionTab(chat)
      await vi.runAllTimersAsync()
      const withChat = runtime.mobileSessionTabsByWorktree.get(WT)
      seen.forEach((events) => (events.length = 0))
      await runtime.publishStructuredAgentSessionTab(chat)
      await vi.runAllTimersAsync()
      expect(runtime.mobileSessionTabsByWorktree.get(WT)).toBe(withChat)
      expect(seen).toEqual([[], [], []])
      const listed = await runtime.listMobileSessionTabs(`id:${WT}`)
      expect(listed.activeTabId).toBe('t-0::leaf')
      off.forEach((unsubscribe) => unsubscribe())
    }
  })
})
