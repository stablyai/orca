// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeRun } from '../automations-page-fixtures'
import { AutomationRecentRunsRail } from './AutomationRecentRunsRail'

afterEach(() => {
  cleanup()
})

const noop = (): void => {}
// Local-time instants, so the expected text does not depend on the machine's time zone.
const FIRST = new Date(2026, 10, 1, 1, 0).getTime()
const LATEST = new Date(2026, 10, 9, 1, 0).getTime()

it('shows a folded run at its latest occurrence, the time the list and detail show', () => {
  const folded = makeRun({
    id: 'folded',
    runNumber: 12,
    status: 'skipped_unavailable',
    scheduledFor: FIRST,
    createdAt: FIRST,
    occurrenceCount: 9,
    lastOccurrenceAt: LATEST
  })
  const { container } = render(
    <AutomationRecentRunsRail
      runs={[folded]}
      notice={null}
      onRecoverHistory={noop}
      onOpenRun={noop}
      onShowAllRuns={noop}
    />
  )
  const text = container.querySelector('[data-automation-run-id="folded"]')?.textContent ?? ''
  expect(text).toContain('Nov 9 at 1:00 AM')
  expect(text).not.toContain('Nov 1 at')
})
