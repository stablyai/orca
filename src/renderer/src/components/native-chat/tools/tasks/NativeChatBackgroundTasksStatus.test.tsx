// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
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
        onShowCommand={command}
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
