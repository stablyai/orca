// @vitest-environment happy-dom

/**
 * A run must change the list the user is looking at.
 *
 * Same shape as the save path: once any host has answered, the page renders the
 * per-host cache, so the legacy `automations` state that `refresh()` writes is
 * off screen and the cached row keeps its pre-run schedule until the entry is
 * invalidated. A run is not a definition write, but it does rewrite what this
 * host reports for the row, and that is what the list shows.
 */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import {
  api,
  installAutomationsPageHarness,
  listedRow,
  mocks,
  renderPage,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation } from './automations-page-fixtures'

installAutomationsPageHarness()

const DESKTOP_SELF_FILTER = {
  kind: 'host' as const,
  host: { authority: { kind: 'desktop' as const }, selector: { kind: 'self' as const } }
}

const BEFORE_RUN = makeAutomation({ id: 'a-1', name: 'Nightly', nextRunAt: 1_000 })
const AFTER_RUN: Automation = { ...BEFORE_RUN, nextRunAt: 2_000, lastRunAt: 1_500 }

/** The desktop store now reports the post-run projection; every later read must say so. */
function desktopStoreHolds(automations: Automation[]): void {
  api.automations.list.mockResolvedValue(automations)
  scopedList(automations)
}

/** The next-run column reads this; the mocked list panel renders only names. */
function listedNextRunAt(): number | null | undefined {
  return mocks.listPanel?.filteredRows[0]?.automation.nextRunAt
}

describe('AutomationsPage run visibility', () => {
  it('shows the post-run schedule the host reports, not the row the run started from', async () => {
    desktopStoreHolds([BEFORE_RUN])
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER

    await renderPage()
    await settleHostQueries()
    expect(listedNextRunAt()).toBe(1_000)

    desktopStoreHolds([AFTER_RUN])
    const row = listedRow('a-1')
    await act(async () => {
      mocks.listPanel?.runNow(row)
    })
    await settleHostQueries()

    expect(api.automations.runNow).toHaveBeenCalledTimes(1)
    expect(listedNextRunAt()).toBe(2_000)
  })

  it('re-asks the host the run was dispatched to', async () => {
    desktopStoreHolds([BEFORE_RUN])
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER

    await renderPage()
    await settleHostQueries()
    const listedBefore = api.automations.listScoped.mock.calls.length

    await act(async () => {
      mocks.listPanel?.runNow(listedRow('a-1'))
    })
    await settleHostQueries()

    // The cache TTL has not expired, so a refetch here can only come from the
    // invalidation the run itself fed in.
    expect(api.automations.listScoped.mock.calls.length).toBeGreaterThan(listedBefore)
  })
})
