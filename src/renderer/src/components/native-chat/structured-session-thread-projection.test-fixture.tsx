import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'
import {
  useThreadMembership,
  useThreadRow,
  useStructuredSessionSummaries
} from './structured-session-summary-store'
import { useWorktreeAgentRows } from '../sidebar/useWorktreeAgentRows'
import { useDesktopVisibleGroups } from '../threads/use-desktop-tab-projection'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'

export function registerThreadProjectionContractTests({
  floatingTab,
  summary,
  feed,
  subscriptionCount
}: {
  floatingTab: Tab
  summary: (overrides?: Partial<AgentSessionStatusSummary>) => AgentSessionStatusSummary
  feed: (index?: number) => { emit: (event: AgentSessionStatusEvent) => void }
  subscriptionCount: () => number
}): void {
  it.each([20, 200])(
    'isolates thread organization, addressed rows and workspace consumers at %i ordinary sessions',
    async (count) => {
      const ordinary = Array.from({ length: count }, (_, i) => ({
        ...floatingTab,
        id: `ordinary-${i}`,
        entityId: `ordinary-${i}`,
        worktreeId: 'ordinary'
      }))
      const thread = { ...floatingTab, id: 'thread', entityId: 'thread', worktreeId: 'shown' }
      const other = {
        ...floatingTab,
        id: 'other',
        entityId: 'other',
        worktreeId: 'other',
        executionHostId: 'runtime:paired' as const
      }
      const tabs = [...ordinary, thread, other]
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings!, experimentalThreads: true },
        unifiedTabsByWorktree: { ordinary, shown: [thread], other: [other] }
      })
      const counts = new Map<string, number>()
      const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
      function Row({ id }: { id: string }) {
        const row = useThreadRow(id)
        bump(id)
        return <span>{row?.title}</span>
      }
      function Workspace({ id, active = true }: { id: string; active?: boolean }) {
        useThreadMembership(id, active)
        useDesktopVisibleGroups(id, [], active)
        useWorktreeAgentRows(id, active)
        bump(`${id}-workspace`)
        return null
      }
      const view = render(
        <>
          <StructuredAgentSessionStatusBridge />
          <Row id="thread" />
          <Row id="other" />
          <Workspace id="shown" />
          <Workspace id="off" active={false} />
        </>
      )
      await waitFor(() => expect(subscriptionCount()).toBe(2))
      act(() =>
        feed(0).emit({
          type: 'snapshot',
          sessions: tabs
            .filter((t) => t.executionHostId === 'local')
            .map((t) =>
              summary({
                sessionId: t.entityId,
                workspaceId: t.worktreeId,
                ...(t === thread ? { surface: 'thread' as const } : {})
              })
            )
        })
      )
      act(() =>
        feed(1).emit({
          type: 'snapshot',
          sessions: [summary({ sessionId: 'other', workspaceId: 'other' })]
        })
      )
      counts.clear()
      const structure = useStructuredSessionSummaries.getState()
      let visits = 0
      const existingFeedSnapshot = getStructuredAgentSessionStatusFeed({
        kind: 'local'
      }).getSnapshot()
      const iterator = Map.prototype[Symbol.iterator]
      const spy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
        this: Map<unknown, unknown>
      ) {
        const entries = iterator.call(this)
        // The pre-existing host feed folds its own immutable snapshot; count only added projections.
        if (this === existingFeedSnapshot) {
          return entries
        }
        const next = entries.next.bind(entries)
        entries.next = () => {
          const item = next()
          const value = item.value?.[1]
          if (
            !item.done &&
            value &&
            typeof value === 'object' &&
            'sessionId' in value &&
            'latestPrompt' in value
          ) {
            visits++
          }
          return item
        }
        return entries
      })
      try {
        act(() =>
          feed(0).emit({
            type: 'status',
            session: summary({
              sessionId: ordinary[0].entityId,
              workspaceId: 'ordinary',
              updatedAt: 2
            })
          })
        )
        expect(visits).toBeLessThanOrEqual(2)
        expect(useStructuredSessionSummaries.getState()).toBe(structure)
        expect(counts.size).toBe(0)
        // Each publication gets its own React turn after the initial effects.
        act(() =>
          feed(1).emit({
            type: 'status',
            session: summary({ sessionId: 'other', workspaceId: 'other', surface: 'thread' })
          })
        )
        expect(counts.has('thread')).toBe(false)
        expect(counts.has('shown-workspace')).toBe(false)
        expect(counts.has('off-workspace')).toBe(false)
        counts.clear()
        act(() =>
          feed(0).emit({
            type: 'status',
            session: summary({
              sessionId: 'thread',
              workspaceId: 'shown',
              surface: 'thread',
              conversationName: 'Addressed title'
            })
          })
        )
        expect(counts.get('thread')).toBe(1)
        expect(counts.has('other')).toBe(false)
        expect(counts.has('shown-workspace')).toBe(false)
        expect(screen.getByText('Addressed title')).toBeTruthy()
        counts.clear()
        act(() =>
          feed(0).emit({
            type: 'status',
            session: summary({
              sessionId: 'thread',
              workspaceId: 'shown',
              surface: 'thread',
              conversationName: 'Addressed title',
              launchDirectory: '/unused'
            })
          })
        )
        expect(counts.size).toBe(0)
        act(() =>
          useAppStore.setState({
            settings: { ...useAppStore.getState().settings!, experimentalThreads: false }
          })
        )
        view.unmount()
        const quiet = useStructuredSessionSummaries.getState()
        act(() =>
          feed(0).emit({
            type: 'status',
            session: summary({ sessionId: ordinary[0].entityId, updatedAt: 3 })
          })
        )
        expect(useStructuredSessionSummaries.getState()).toBe(quiet)
      } finally {
        spy.mockRestore()
      }
    }
  )
}

// Observe actual collection work without replacing the private members or groups.
export function measureMembership(trigger: () => void) {
  const work = { members: 0, groups: 0 }
  function observe<T>(iterator: MapIterator<T>): MapIterator<T> {
    const next = iterator.next.bind(iterator)
    iterator.next = () => {
      const item = next()
      const value: unknown = Array.isArray(item.value) ? item.value[1] : item.value
      if (!item.done && value && typeof value === 'object') {
        if ('paneKey' in value && 'group' in value && 'tab' in value) {
          work.members += 1
        }
        if ('feed' in value && 'unsubscribe' in value) {
          work.groups += 1
        }
      }
      return item
    }
    return iterator
  }
  const values = Map.prototype.values
  const entries = Map.prototype[Symbol.iterator]
  const spies = [
    vi.spyOn(Map.prototype, 'values').mockImplementation(function (this: Map<unknown, unknown>) {
      return observe(values.call(this))
    }),
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return observe(entries.call(this))
    })
  ]
  try {
    act(trigger)
    return work
  } finally {
    for (const spy of spies) {
      spy.mockRestore()
    }
  }
}
