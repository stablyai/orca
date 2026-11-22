// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorkerDockRowView } from './dock/WorkerDockRow'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'

afterEach(cleanup)
it('opens a command through its command route and retains capability-gated untargeted Stop', () => {
  const stop = vi.fn()
  const command = vi.fn()
  const agent = vi.fn()
  render(
    <TooltipProvider>
      <NativeChatBackgroundTasksStatus
        tasks={[
          { id: 'shell-7', kind: 'command', description: 'Verify the journal', state: 'working' }
        ]}
        settledTasks={[]}
        supportsTaskStop={false}
        offersStopAll
        incomplete
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        indicatorActive
        isVisible
        expanded
        onExpandedChange={() => {}}
        onStop={stop}
        onShowProviderDetails={command}
        onShowAgent={agent}
      />
    </TooltipProvider>
  )
  const opener = within(screen.getByRole('region', { name: 'Workers' })).getAllByRole('button')[0]
  fireEvent.click(opener)
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'command', providerId: 'shell-7' }),
    opener
  )
  expect(agent).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }))
  expect(stop).toHaveBeenCalledWith()
})

it('opens captured invocation details for a retained provider failure', () => {
  const details = vi.fn()
  const agent = vi.fn()
  const row: WorkerDockRowView = {
    id: 'invocation-1',
    dispatchId: 'invocation-1',
    source: 'source',
    kind: 'agent',
    name: 'Old agent',
    title: 'Verify the journal',
    model: null,
    state: 'failed',
    changedAt: 100,
    startedAt: 0,
    reason: 'Original failure.',
    settlement: 'first-failure',
    resultId: null,
    stoppable: false,
    ownerActionsAvailable: true
  }
  render(
    <TooltipProvider>
      <NativeChatBackgroundTasksStatus
        tasks={[]}
        settledTasks={[]}
        supportsTaskStop={false}
        offersStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        indicatorActive={false}
        isVisible
        expanded
        onExpandedChange={() => {}}
        onStop={() => {}}
        workerRows={new Map([[row.id, row]])}
        workerIdentities={[row]}
        onShowProviderDetails={details}
        onShowAgent={agent}
      />
    </TooltipProvider>
  )
  // The newest needs-attention row is the lead row: it opens from its own Show.
  const opener = screen.getByRole('button', { name: 'Show Old agent' })
  fireEvent.click(opener)
  expect(details).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'agent',
      settlement: 'first-failure',
      reason: 'Original failure.'
    }),
    opener
  )
  expect(agent).not.toHaveBeenCalled()
})

it('marks the folded header needs-you over failed over neutral', () => {
  const row = (id: string, state: WorkerDockRowView['state']): WorkerDockRowView => ({
    id,
    dispatchId: id,
    source: 'source',
    kind: 'worker',
    name: id,
    title: 'Task',
    model: null,
    state,
    changedAt: 100,
    startedAt: 0,
    reason: null,
    settlement: null,
    resultId: null,
    stoppable: state === 'running',
    ownerActionsAvailable: true
  })
  const header = (rows: WorkerDockRowView[]) => {
    cleanup()
    const { container } = render(
      <TooltipProvider>
        <NativeChatBackgroundTasksStatus
          tasks={[]}
          settledTasks={[]}
          supportsTaskStop={false}
          offersStopAll={false}
          stoppingTaskIds={new Set()}
          stoppingAll={false}
          indicatorActive
          isVisible
          expanded={false}
          onExpandedChange={() => {}}
          onStop={() => {}}
          workerRows={new Map(rows.map((entry) => [entry.id, entry]))}
          workerIdentities={rows}
        />
      </TooltipProvider>
    )
    const summary = container.querySelector('[data-worker-dock-header] > button')
    return {
      urgent: summary?.querySelector('[data-worker-dock-urgent]') !== null,
      failed: summary?.querySelector('[data-worker-dock-failed]') !== null
    }
  }
  expect(header([row('a', 'failed')])).toEqual({ urgent: false, failed: true })
  expect(header([row('a', 'failed'), row('b', 'needs-you')])).toEqual({
    urgent: true,
    failed: false
  })
  expect(header([row('a', 'running')])).toEqual({ urgent: false, failed: false })
})
