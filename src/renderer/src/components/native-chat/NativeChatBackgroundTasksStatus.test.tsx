// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen } from '@testing-library/react'
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
