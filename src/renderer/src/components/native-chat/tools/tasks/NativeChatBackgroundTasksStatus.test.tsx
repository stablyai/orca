// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'

afterEach(cleanup)

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
  fireEvent.click(screen.getByRole('button', { name: 'Open child a' }))
  expect(onShowAgent).toHaveBeenCalledWith('provider-a')
  expect(onStop).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /Show child s/ })).toBeNull()
})
