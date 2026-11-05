// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Own disclosure outside the strip so temporary roster gaps cannot reset expansion. */

it('lets the 1 Hz tick sleep while every row has settled, with each run frozen', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const committed = vi.fn()
  const finished = (id: string, firstObservedAt: number, settledAt: number) => ({
    id,
    providerId: `task-${id}`,
    kind: 'agent' as const,
    description: `child ${id}`,
    state: 'done' as const,
    membership: 'settled' as const,
    outcome: 'succeeded' as const,
    firstObservedAt,
    observedAt: settledAt,
    settledAt,
    stoppable: false,
    invocation: { invocationId: `spawn-${id}`, generation: 1 }
  })
  render(
    <Profiler id="strip" onRender={committed}>
      <NativeChatBackgroundTasksStatus
        expanded
        onExpandedChange={() => {}}
        isVisible
        tasks={[]}
        settledTasks={[]}
        childViews={[finished('a', 400_000, 520_000), finished('b', 700_000, 760_000)]}
        indicatorActive
        supportsTaskStop
        offersStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={() => {}}
      />
    </Profiler>
  )
  const rows = screen.getAllByRole('listitem').map((row) => row.textContent)
  expect(rows).toEqual(['child a · Agent2m 0s', 'child b · Agent1m 0s'])
  committed.mockClear()
  act(() => vi.advanceTimersByTime(5_000))
  expect(committed).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("shows an agent by the provider's id, beside its own Stop, and leaves command rows inert", () => {
  const running = (id: string, kind: 'agent' | 'command') => ({
    id: `host-${id}`,
    providerId: `provider-${id}`,
    kind,
    description: `child ${id}`,
    state: 'working' as const,
    membership: 'live' as const,
    firstObservedAt: 1_000,
    observedAt: 2_000,
    stoppable: true,
    invocation: { invocationId: `spawn-${id}`, generation: 1 }
  })
  const onShowAgent = vi.fn()
  const onStop = vi.fn()
  render(
    <NativeChatBackgroundTasksStatus
      expanded
      onExpandedChange={() => {}}
      isVisible
      tasks={[]}
      settledTasks={[]}
      childViews={[running('a', 'agent'), running('s', 'command')]}
      indicatorActive
      supportsTaskStop
      offersStopAll={false}
      stoppingTaskIds={new Set()}
      stoppingAll={false}
      onStop={onStop}
      onShowAgent={onShowAgent}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Show child a in the conversation' }))
  expect(onShowAgent).toHaveBeenCalledWith('provider-a')
  expect(onStop).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /Show child s/ })).toBeNull()
})
