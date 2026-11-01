// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

describe('workspace activity summary subscriptions', () => {
  it('refreshes the late chat row while keeping unrelated rows quiet at 10 and 100 workspaces', () => {
    const original = useAppStore.getState()
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const operations: number[] = []
    try {
      for (const count of [10, 100]) {
        let visits = 0
        const renders = Array.from({ length: count }, () => 0)
        const statuses: Record<string, AgentStatusEntry> = {}
        for (let index = 0; index < count; index++) {
          const paneKey = structuredAgentSessionPaneKey(
            `restored:chat-${index}`,
            `session-${index}`
          )
          const entry: AgentStatusEntry = {
            paneKey,
            worktreeId: `folder-${index}`,
            state: 'working',
            prompt: '',
            updatedAt: 1_000,
            stateStartedAt: 1_000,
            stateHistory: []
          }
          Object.defineProperty(statuses, paneKey, {
            enumerable: true,
            get() {
              visits++
              return entry
            }
          })
        }
        useAppStore.setState({
          agentStatusByPaneKey: statuses,
          agentStatusEpoch: 0,
          tabsByWorktree: {},
          unifiedTabsByWorktree: {},
          groupsByWorktree: {},
          activeGroupIdByWorktree: {},
          runtimeAgentOrchestrationByPaneKey: {},
          migrationUnsupportedByPtyId: {},
          retainedAgentsByPaneKey: {}
        })
        function Row({ index }: { index: number }) {
          const status = useWorktreeActivityStatus(`folder-${index}`)
          renders[index]++
          return <span data-row={index}>{status}</span>
        }
        const container = document.createElement('div')
        const root = createRoot(container)
        try {
          act(() => root.render(renders.map((_, index) => <Row key={index} index={index} />)))
          renders.fill(0)
          visits = 0
          act(() => useAppStore.setState({ uiZoomLevel: original.uiZoomLevel + 1 }))
          expect(renders).toEqual(Array(count).fill(0))
          expect(visits).toBe(0)

          const before = useAppStore.getState()
          act(() =>
            useAppStore.getState().createUnifiedTab('folder-0', 'agent-session', {
              id: 'restored:chat-0',
              entityId: 'session-0',
              agentSessionAgent: 'claude',
              activate: false,
              recordInteraction: false
            })
          )
          const after = useAppStore.getState()
          expect(after.agentStatusEpoch).toBe(before.agentStatusEpoch)
          expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
          expect(after.agentStatusByPaneKey).toBe(before.agentStatusByPaneKey)
          expect(container.querySelector('[data-row="0"]')?.textContent).toBe('working')
          expect(renders).toEqual([1, ...Array(count - 1).fill(0)])
          expect(visits).toBeGreaterThan(0)
          expect(visits).toBeLessThanOrEqual(count * 4)
          operations.push(visits)
        } finally {
          act(() => root.unmount())
        }
      }
      expect(operations[1]).toBeLessThanOrEqual(operations[0] * 10)
    } finally {
      useAppStore.setState(original, true)
      now.mockRestore()
    }
  })
})
