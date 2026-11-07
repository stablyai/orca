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
import * as selection from '../../../src/main/runtime/session-tabs/mobile-session-tab-selection'
import * as membership from '../../../src/main/runtime/session-lifecycle/projection/mobile-session-tab-merge'
import * as mainOrder from '../../../src/main/runtime/session-tabs/main-session-tab-order'
import { normalizeMobileSessionTabSelection } from '../../../src/main/runtime/session-tabs/mobile-session-tab-selection'
import { createRuntimeFixture } from './active-tab-publication.test-fixture'
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

function countedIdentities<T extends { id: string }>(rows: T[]) {
  let reads = 0
  for (const row of rows) {
    const id = row.id
    Object.defineProperty(row, 'id', {
      get() {
        reads++
        return id
      }
    })
  }
  return {
    reads: () => reads,
    reset: () => {
      reads = 0
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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('active-tab selection performance contract', () => {
  it('bounds saved-order publication selection at N and 10N without rematerializing navigation', () => {
    for (const navigation of ['pending', 'null', 'activate'] as const) {
      const measurements: number[] = []
      for (const count of [50, 500]) {
        const sessionIds = Array.from({ length: count }, (_, index) => `saved-scale-${index}`)
        const rawId = (id: string) => `agent-session:${id}`
        const savedId = (id: string) => `structured-agent-session-${id}`
        const groupId = (index: number) => (index < count / 2 ? 'left' : 'right')
        const saved = {
          ...getDefaultWorkspaceSession(),
          activeWorktreeId: WT,
          unifiedTabs: {
            [WT]: sessionIds.map((id, index) => ({
              id: savedId(id),
              entityId: id,
              contentType: 'agent-session' as const,
              agentSessionAgent: 'codex' as const,
              executionHostId: 'local' as const,
              worktreeId: WT,
              groupId: groupId(index),
              label: id,
              customLabel: null,
              color: null,
              sortOrder: index,
              createdAt: 1
            }))
          },
          tabGroups: {
            [WT]: ['left', 'right'].map((id) => ({
              id,
              worktreeId: WT,
              activeTabId: savedId(sessionIds[id === 'left' ? 0 : count / 2]!),
              tabOrder: sessionIds.filter((_, index) => groupId(index) === id).map(savedId)
            }))
          },
          activeGroupIdByWorktree: { [WT]: 'left' }
        }
        const fixture = makeRuntimeStoreWithWorkspaceSession(saved)
        const runtime = new OrcaRuntimeService(fixture.runtimeStore)
        const declared = navigation === 'pending' ? 'agent-session:pending' : null
        runtime.storeMobileSessionSnapshot(WT, {
          worktree: WT,
          publicationEpoch: 'headless:saved-order-scale',
          snapshotVersion: 1,
          activeGroupId: 'right',
          activeTabId: null,
          activeTabType: null,
          tabGroups: ['left', 'right'].map((id) => ({
            id,
            activeTabId: id === 'right' ? declared : null,
            tabOrder: sessionIds
              .slice(0, -1)
              .filter((_, index) => groupId(index) === id)
              .map(rawId)
          })),
          tabs: sessionIds.slice(0, -1).map((id) => ({
            type: 'agent-session',
            id: rawId(id),
            sessionId: id,
            agent: 'codex',
            title: 'Chat',
            isActive: false
          }))
        })
        const resolve = vi.spyOn(selection, 'resolveMobileSessionActiveTab')
        const normalize = vi.spyOn(selection, 'normalizeMobileSessionTabSelection')
        const restore = vi.spyOn(selection, 'restoreLegacyMobileSessionNavigation')
        const select = vi.spyOn(selection, 'selectMobileSessionTab')
        const order = vi.spyOn(mainOrder, 'withMainTabOrder')
        runtime.projectStructuredAgentSessionTab({
          workspaceId: WT,
          sessionId: sessionIds[count - 1]!,
          agent: 'codex',
          activate: navigation === 'activate',
          notify: false
        })
        expect(order).toHaveBeenCalledTimes(1)
        const population =
          resolve.mock.calls.reduce((total, [, tabs]) => total + tabs.length, 0) +
          [normalize, restore, select].reduce(
            (total, spy) =>
              total + spy.mock.calls.reduce((sum, [snapshot]) => sum + snapshot.tabs.length, 0),
            0
          )
        // One written resolution and one output materialization; internal selector work has its own contract.
        expect(population).toBeGreaterThan(0)
        expect(population).toBeLessThanOrEqual(2 * count)
        measurements.push(population)
        const result = runtime.mobileSessionTabsByWorktree.get(WT)!
        expect(result.tabs).toHaveLength(count)
        expect(result.activeGroupId).toBe('right')
        expect(result.activeTabId).toBe(
          navigation === 'activate' ? rawId(sessionIds[count - 1]!) : null
        )
        expect(result.tabGroups?.find((group) => group.id === 'right')?.activeTabId).toBe(
          navigation === 'activate' ? rawId(sessionIds[count - 1]!) : declared
        )
        expect(result.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(
          navigation === 'activate' ? [rawId(sessionIds[count - 1]!)] : []
        )
        vi.restoreAllMocks()
      }
      expect(measurements[1]).toBeLessThanOrEqual(10 * measurements[0]!)
    }
  })
  it('bounds admitted placement reconciliation during supported reads at N and 10N', async () => {
    vi.useFakeTimers()
    const merge = membership.mergeMobileSessionTabGroups
    const measurements: number[] = []
    for (const count of [50, 500]) {
      const { runtime, getSession, setSession } = createRuntimeFixture()
      const savedGroups = frame(count).tabGroups!.map((group) => ({ ...group, worktreeId: WT }))
      savedGroups[0]!.tabOrder.push('serve-tab')
      setSession({ ...getSession(), tabGroups: { [WT]: savedGroups } })
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [frame(count)]
      })
      await vi.runAllTimersAsync()
      let visits = 0
      let reconciliations = 0
      const spy = vi
        .spyOn(membership, 'mergeMobileSessionTabGroups')
        .mockImplementation((worktreeId, groups, tabs, activeTab, placementGroups) => {
          if (placementGroups !== savedGroups) {
            return merge(worktreeId, groups, tabs, activeTab, placementGroups)
          }
          reconciliations++
          const orders = savedGroups.map((group) => counted(group.tabOrder))
          const source = counted(
            savedGroups.map((group, index) => ({ ...group, tabOrder: orders[index]!.rows }))
          )
          const result = merge(worktreeId, groups, tabs, activeTab, source.rows)
          visits += source.visits() + orders.reduce((total, order) => total + order.visits(), 0)
          return result
        })
      const result = await runtime.listMobileSessionTabs(`id:${WT}`)
      expect(result.activeGroupId).toBe(`g-${count - 1}`)
      expect(result.tabGroups?.find((group) => group.id === 'g-0')?.tabOrder).toContain('serve-tab')
      expect(reconciliations).toBe(1)
      // Placement needs one visit per source group and member, independently of the selected row.
      expect(visits).toBeGreaterThan(0)
      expect(visits).toBeLessThanOrEqual(2 * (count + 1))
      measurements.push(visits)
      spy.mockRestore()
    }
    expect(measurements[1]).toBeLessThanOrEqual(10 * measurements[0]!)
  })

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
      expect(unavailable.tabs[0]).toBe(rows.rows[0])
    }
    expect(measurements[1]).toBeLessThanOrEqual(10 * measurements[0]!)
  })

  it('keeps publication scoped to a changed worktree and shared by listeners at N and 10N', async () => {
    vi.useFakeTimers()
    const normalizations = vi.spyOn(selection, 'normalizeMobileSessionTabSelection')
    const measurements: number[] = []
    for (const count of [50, 500]) {
      const listenerWork: number[] = []
      for (const listenerCount of [1, 3]) {
        const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
        const runtime = new OrcaRuntimeService(runtimeStore)
        runtime.attachWindow(1)
        const other = `${WT}-unaffected`
        const countedOther = counted(frame(count, 1, other).tabs)
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          mobileSessionTabs: [frame(count), { ...frame(count, 1, other), tabs: countedOther.rows }]
        })
        await vi.runAllTimersAsync()
        const unaffected = runtime.mobileSessionTabsByWorktree.get(other)
        const seen: string[][] = Array.from({ length: listenerCount }, () => [])
        const delivered: unknown[] = []
        const off = seen.map((events) =>
          runtime.onMobileSessionTabsChanged((snapshot) => {
            events.push(snapshot.worktree)
            delivered.push(snapshot.tabs)
          })
        )
        const changed = frame(count, 2)
        changed.activeGroupId = 'g-0'
        changed.activeTabId = 't-0::leaf'
        changed.tabs = changed.tabs.map((tab, index) => ({ ...tab, isActive: index === 0 }))
        const countedRows = counted(changed.tabs)
        changed.tabs = countedRows.rows
        countedOther.reset()
        normalizations.mockClear()
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          mobileSessionTabs: [changed],
          unchangedMobileSessionWorktrees: [other]
        })
        await vi.runAllTimersAsync()
        expect(seen).toEqual(Array.from({ length: listenerCount }, () => [WT]))
        expect(delivered.every((result) => result === delivered[0])).toBe(true)
        expect(countedOther.visits()).toBe(0)
        expect(normalizations.mock.calls).toHaveLength(2)
        expect(
          normalizations.mock.calls.every(
            ([snapshot]) => 'worktree' in snapshot && snapshot.worktree === WT
          )
        ).toBe(true)
        listenerWork.push(countedRows.visits())
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
        expect(seen.every((events) => events.length === 0)).toBe(true)
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
        expect(seen.every((events) => events.length === 0)).toBe(true)
        const listed = await runtime.listMobileSessionTabs(`id:${WT}`)
        expect(listed.activeTabId).toBe('t-0::leaf')
        off.forEach((unsubscribe) => unsubscribe())
      }
      expect(listenerWork[1]).toBe(listenerWork[0])
      measurements.push(listenerWork[0]!)
    }
    expect(measurements[1]).toBeLessThanOrEqual(10 * measurements[0]!)
  })
  it.each([false, true])(
    'bounds preserved-chat merge and runtime-owned hydration at N and 10N (legacy=%s)',
    async (legacy) => {
      vi.useFakeTimers()
      const normalizations = vi.spyOn(selection, 'normalizeMobileSessionTabSelection')
      const conversions = vi.spyOn(selection, 'restoreLegacyMobileSessionNavigation')
      const measurements: number[] = []
      const identityReads: number[] = []
      for (const count of [50, 500]) {
        const { runtime } = createRuntimeFixture()
        await runtime.publishStructuredAgentSessionTab({
          workspaceId: WT,
          sessionId: 'scale-chat',
          agent: 'codex',
          activate: false
        })
        if (legacy) {
          await runtime.listMobileSessionTabs(`id:${WT}`)
        }
        const retained = legacy ? (runtime.mobileSessionTabsByWorktree.get(WT)?.tabs ?? []) : []
        const next = frame(count)
        if (legacy) {
          next.tabGroups = undefined
          next.tabs.push(...retained.map((tab) => ({ ...tab, isActive: false })))
        }
        const priorReads = countedIdentities(next.tabs)
        runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [next] })
        await vi.runAllTimersAsync()
        // One hydration, one accepted membership composition and one shared emission can resolve selection.
        normalizations.mockClear()
        const changed = frame(count, 2)
        if (legacy) {
          changed.tabGroups = undefined
          changed.tabs.push(...retained.map((tab) => ({ ...tab, isActive: false })))
        }
        const currentReads = countedIdentities(changed.tabs)
        priorReads.reset()
        runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [changed] })
        if (legacy) {
          const accepted = runtime.mobileSessionTabsByWorktree.get(WT)
          expect(accepted?.tabGroups).toBeUndefined()
          // Measure this admitted frame's supported read, including its conversion and delivery.
          normalizations.mockClear()
          conversions.mockClear()
          priorReads.reset()
          currentReads.reset()
          const seen: unknown[] = []
          const off = runtime.onMobileSessionTabsChanged((snapshot) => seen.push(snapshot))
          expect((await runtime.listMobileSessionTabs(`id:${WT}`)).activeTabId).toBe(
            `t-${count - 1}::leaf`
          )
          await vi.runAllTimersAsync()
          expect(conversions.mock.calls).toHaveLength(1)
          expect(conversions.mock.calls[0]?.[1]).toBe(accepted)
          // One conversion plus public list/delivery projections; internal normalization is lexical.
          const population = [...normalizations.mock.calls, ...conversions.mock.calls].reduce(
            (total, [snapshot]) => total + snapshot.tabs.length,
            0
          )
          expect(population).toBeLessThanOrEqual(3 * (count + 2))
          measurements.push(population)
          identityReads.push(priorReads.reads() + currentReads.reads())
          const stored = runtime.mobileSessionTabsByWorktree.get(WT)
          conversions.mockClear()
          seen.length = 0
          expect((await runtime.listMobileSessionTabs(`id:${WT}`)).activeTabId).toBe(
            `t-${count - 1}::leaf`
          )
          await vi.runAllTimersAsync()
          expect(conversions.mock.calls).toHaveLength(0)
          expect(runtime.mobileSessionTabsByWorktree.get(WT)).toBe(stored)
          expect(seen).toEqual([])
          off()
          continue
        }
        await vi.runAllTimersAsync()
        expect(normalizations.mock.calls.length).toBeLessThanOrEqual(3)
        expect(normalizations.mock.calls.length).toBeGreaterThanOrEqual(2)
        const selectionRows = normalizations.mock.calls.reduce(
          (total, [snapshot]) => total + snapshot.tabs.length,
          0
        )
        expect(selectionRows).toBeLessThanOrEqual(3 * (count + 2))
        measurements.push(selectionRows)
        identityReads.push(priorReads.reads() + currentReads.reads())
        expect((await runtime.listMobileSessionTabs(`id:${WT}`)).activeTabId).toBe(
          `t-${count - 1}::leaf`
        )
        normalizations.mockClear()
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          mobileSessionTabs: [],
          unchangedMobileSessionWorktrees: [WT]
        })
        await vi.runAllTimersAsync()
        // Rebuild derives selection once even when its equality gate retains the stored object.
        expect(normalizations.mock.calls).toHaveLength(1)
        expect(normalizations.mock.calls[0]?.[0].tabs.length).toBe(count + 2)
      }
      expect(measurements[1]).toBeLessThanOrEqual(10 * measurements[0]!)
      expect(identityReads[1]).toBeLessThanOrEqual(10 * identityReads[0]!)
    }
  )
  it('bounds actual native retirement and shared delivery work at N and 10N', async () => {
    vi.useFakeTimers()
    const reads: number[] = []
    for (const count of [50, 500]) {
      const { runtime } = createRuntimeFixture(false)
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      const rows = Array.from({ length: count }, (_, index) => ({
        type: 'agent-session' as const,
        id: `agent-session:scale-${index}`,
        sessionId: `scale-${index}`,
        agent: 'codex' as const,
        title: 'Chat',
        isActive: index === count - 1
      }))
      runtime.syncWindowGraph(0, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: WT,
            publicationEpoch: 'headless:retirement-scale',
            snapshotVersion: 10,
            activeGroupId: `g-${count - 1}`,
            activeTabId: `agent-session:scale-${count - 1}`,
            activeTabType: 'agent-session',
            tabGroups: rows.map((row, index) => ({
              id: `g-${index}`,
              activeTabId: row.id,
              tabOrder: [row.id]
            })),
            tabs: rows
          }
        ]
      })
      await vi.runAllTimersAsync()
      const stored = runtime.mobileSessionTabsByWorktree.get(WT)!
      const meter = countedIdentities(stored.tabs)
      const other = 'other::/tmp/retirement-scale'
      const unaffected = frame(count, 1, other)
      const otherMeter = countedIdentities(unaffected.tabs)
      runtime.mobileSessionTabsByWorktree.set(other, unaffected)
      const seen: string[] = []
      const off = runtime.onMobileSessionTabsChanged((snapshot) =>
        seen.push(snapshot.activeTabId ?? 'null')
      )
      meter.reset()
      expect(
        runtime.retireStructuredAgentSessionTabFromSnapshot(
          `scale-${count - 1}`,
          `agent-session:scale-${count - 1}`,
          WT
        )
      ).toBe(true)
      await vi.runAllTimersAsync()
      reads.push(meter.reads())
      expect(meter.reads()).toBeGreaterThan(0)
      expect(otherMeter.reads()).toBe(0)
      expect(runtime.mobileSessionTabsByWorktree.get(other)).toBe(unaffected)
      expect(seen).toEqual(['agent-session:scale-0'])
      expect((await runtime.listMobileSessionTabs(`id:${WT}`)).activeTabId).toBe(
        'agent-session:scale-0'
      )
      off()
    }
    expect(reads[1]).toBeLessThanOrEqual(10 * reads[0]!)
  })
})
