// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

type Work = { statuses: number; tabs: number }

describe('workspace activity summary subscriptions', () => {
  it('keeps rows quiet on status pings and title writes and refreshes only the changed chat at 10 and 100 workspaces', () => {
    const original = useAppStore.getState()
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const operations: Record<string, Work[]> = {}
    try {
      for (const count of [10, 100]) {
        const renders = Array.from({ length: count }, () => 0)
        const worktreeIds = renders.map((_, index) => `folder-${index}`)
        const work: Work = { statuses: 0, tabs: 0 }
        let counting = false
        // Counts each read of a status entry or chat tab, whichever code scans it.
        const countReads = (
          record: Readonly<Record<string, unknown>> | readonly unknown[],
          key: keyof Work
        ) => {
          for (const property of Object.keys(record)) {
            const descriptor = Object.getOwnPropertyDescriptor(record, property)
            let value = descriptor?.get ? descriptor.get.call(record) : descriptor?.value
            Object.defineProperty(record, property, {
              enumerable: true,
              configurable: true,
              get() {
                if (counting) {
                  work[key]++
                }
                return value
              },
              set(next) {
                value = next
              }
            })
          }
        }
        const countSnapshot = () => {
          const wasCounting = counting
          counting = false
          const state = useAppStore.getState()
          countReads(state.agentStatusByPaneKey, 'statuses')
          for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
            countReads(tabs, 'tabs')
          }
          counting = wasCounting
        }
        const measure = (trigger: string, update: () => void) => {
          countSnapshot()
          work.statuses = 0
          work.tabs = 0
          renders.fill(0)
          counting = true
          try {
            act(update)
          } finally {
            counting = false
          }
          expect(work.statuses).toBeLessThanOrEqual(count * 4)
          expect(work.tabs).toBeLessThanOrEqual(count * 4)
          ;(operations[trigger] ??= []).push({ ...work })
        }
        const paneKey = (index: number) =>
          structuredAgentSessionPaneKey(`restored:chat-${index}`, `session-${index}`)
        const report = (index: number, state: 'working' | 'blocked', updatedAt: number) =>
          useAppStore
            .getState()
            .setAgentStatus(
              paneKey(index),
              { state, agentType: 'claude', prompt: `prompt ${index}` },
              undefined,
              { updatedAt },
              { worktreeId: `folder-${index}` }
            )
        const createChat = (index: number) =>
          useAppStore.getState().createUnifiedTab(`folder-${index}`, 'agent-session', {
            id: `restored:chat-${index}`,
            entityId: `session-${index}`,
            agentSessionAgent: 'claude',
            activate: false,
            recordInteraction: false
          })
        useAppStore.setState({
          agentStatusByPaneKey: {},
          agentStatusEpoch: 0,
          tabsByWorktree: {},
          unifiedTabsByWorktree: {},
          groupsByWorktree: {},
          activeGroupIdByWorktree: {},
          runtimeAgentOrchestrationByPaneKey: {},
          migrationUnsupportedByPtyId: {},
          retainedAgentsByPaneKey: {}
        })
        // Every workspace has a working chat; folder-0's tab arrives after its status.
        for (let index = 0; index < count; index++) {
          if (index > 0) {
            createChat(index)
          }
          report(index, 'working', 1_000)
        }
        function Row({ index }: { index: number }) {
          const status = useWorktreeActivityStatus(`folder-${index}`)
          renders[index]++
          return <span data-row={index}>{status}</span>
        }
        const container = document.createElement('div')
        const root = createRoot(container)
        const text = (index: number) =>
          container.querySelector(`[data-row="${index}"]`)?.textContent
        const quiet = Array(count).fill(0)
        // Why: writers copy records, so wrap each published snapshot before the rows read it.
        const unsubscribe = useAppStore.subscribe(() => {
          if (counting) {
            countSnapshot()
          }
        })
        try {
          act(() =>
            root.render(
              worktreeIds.map((worktreeId, index) => <Row key={worktreeId} index={index} />)
            )
          )
          expect(text(1)).toBe('working')

          measure('unrelated', () =>
            useAppStore.setState({ uiZoomLevel: original.uiZoomLevel + 1 })
          )
          expect(renders).toEqual(quiet)
          expect(work).toEqual({ statuses: 0, tabs: 0 })

          let before = useAppStore.getState()
          measure('late tab', () => createChat(0))
          let after = useAppStore.getState()
          expect(after.agentStatusEpoch).toBe(before.agentStatusEpoch)
          expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
          expect(after.agentStatusByPaneKey).toBe(before.agentStatusByPaneKey)
          expect(text(0)).toBe('working')
          expect(renders).toEqual([1, ...quiet.slice(1)])
          expect(work.statuses).toBeGreaterThan(0)
          expect(work.tabs).toBeGreaterThan(0)

          before = useAppStore.getState()
          measure('same-state ping', () => report(1, 'working', 1_500))
          after = useAppStore.getState()
          expect(after.agentStatusByPaneKey).not.toBe(before.agentStatusByPaneKey)
          expect(after.agentStatusByPaneKey[paneKey(1)]?.updatedAt).toBe(1_500)
          expect(after.agentStatusEpoch).toBe(before.agentStatusEpoch)
          expect(renders).toEqual(quiet)

          before = useAppStore.getState()
          measure('title', () =>
            useAppStore.getState().setTabLabel('restored:chat-1', 'Renamed chat')
          )
          after = useAppStore.getState()
          expect(after.unifiedTabsByWorktree).not.toBe(before.unifiedTabsByWorktree)
          expect(renders).toEqual(quiet)

          measure('state change', () => report(1, 'blocked', 1_600))
          expect(text(1)).toBe('permission')
          expect(renders).toEqual([0, 1, ...quiet.slice(2)])
        } finally {
          unsubscribe()
          act(() => root.unmount())
        }
      }
      for (const [, [small, large]] of Object.entries(operations)) {
        expect(large.statuses).toBeLessThanOrEqual(small.statuses * 10)
        expect(large.tabs).toBeLessThanOrEqual(small.tabs * 10)
      }
    } finally {
      useAppStore.setState(original, true)
      now.mockRestore()
    }
  })
})
