// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ActionsStatus } from './ActionsStatus'
import { actionsStatusTone, ACTIONS_STATUS_TEXT_CLASSES } from './actions-status-tone'
import { CheckRunJobs } from '../editor/CheckRunJobs'
import { TooltipProvider } from '@/components/ui/tooltip'

afterEach(cleanup)
it.each([
  ['success', 'success'],
  ['failure', 'failure'],
  ['failed', 'failure'],
  ['error', 'failure'],
  ['timed_out', 'failure'],
  ['startup_failure', 'failure'],
  ['in_progress', 'running'],
  ['queued', 'waiting'],
  ['waiting', 'waiting'],
  ['requested', 'waiting'],
  ['pending', 'waiting'],
  ['action_required', 'waiting'],
  ['cancelled', 'neutral'],
  ['skipped', 'neutral'],
  ['neutral', 'neutral'],
  ['stale', 'neutral'],
  ['completed', 'neutral'],
  ['future-status', 'neutral'],
  [null, 'neutral']
])('renders %s with the correct semantic color and a readable label', (status, tone) => {
  render(<ActionsStatus status={status} pill />)
  expect(actionsStatusTone(status)).toBe(tone)
  const element = document.querySelector('[data-actions-status]')
  expect(element?.classList.contains(ACTIONS_STATUS_TEXT_CLASSES[actionsStatusTone(status)])).toBe(
    true
  )
  expect(element?.textContent?.length).toBeGreaterThan(0)
  expect(element?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
})
it('uses matching colors for job and step statuses without changing their names', () => {
  render(
    <TooltipProvider>
      <CheckRunJobs
        hasFailedJobs={false}
        actionsStatusColors
        jobs={[
          {
            id: 1,
            name: 'Build job',
            status: 'in_progress',
            conclusion: null,
            startedAt: null,
            completedAt: null,
            url: null,
            logTail: null,
            steps: [
              {
                name: 'Compile',
                status: 'in_progress',
                conclusion: null,
                startedAt: null,
                completedAt: null
              },
              {
                name: 'Publish',
                status: 'queued',
                conclusion: null,
                startedAt: null,
                completedAt: null
              }
            ]
          }
        ]}
      />
    </TooltipProvider>
  )
  expect(screen.getByText('Build job')).toBeTruthy()
  expect(screen.getByText('Compile')).toBeTruthy()
  expect(screen.getByText('Publish')).toBeTruthy()
  for (const element of document.querySelectorAll('[data-actions-status="in_progress"]')) {
    expect(element.classList.contains('text-status-info')).toBe(true)
  }
  for (const element of document.querySelectorAll('[data-actions-status="queued"]')) {
    expect(element.classList.contains('text-status-warning-foreground')).toBe(true)
  }
})
