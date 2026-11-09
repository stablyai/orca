// @vitest-environment happy-dom

import { act } from 'react'
import { within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, makeRun } from './automations-page-fixtures'

vi.mock('@tanstack/react-virtual', async () => {
  const { createVirtualizerStub } = await import('./virtualizer-test-stub')
  return { useVirtualizer: createVirtualizerStub() }
})

installAutomationsPageHarness()

async function loadCachedHistory() {
  const automation = makeAutomation()
  const oldRun = makeRun({ id: 'run-26', runNumber: 26 })
  api.automations.list.mockResolvedValue([automation])
  scopedList([automation])
  api.automations.listRuns.mockResolvedValue([oldRun])
  mocks.state.selectedAutomationId = automation.id
  mocks.state.setPendingAutomationRunNavigation = mocks.setPendingRunNavigation
  mocks.setPendingRunNavigation.mockImplementation((navigation) => {
    mocks.state.pendingAutomationRunNavigation = navigation
  })
  const page = await renderPage()
  await settleHostQueries()
  return { ...page, automation, oldRun }
}

async function openDashboardRun(
  container: HTMLElement,
  newRun: AutomationRun,
  oldRun: AutomationRun
) {
  const fresh = Promise.withResolvers<AutomationRun[]>()
  api.automations.listRuns.mockImplementation((args?: { limit?: number }) =>
    args?.limit ? Promise.resolve([newRun, oldRun]) : fresh.promise
  )
  await act(async () => within(container).getByRole('button', { name: 'Runs' }).click())
  await act(async () => {
    within(container)
      .getByRole('button', { name: new RegExp(newRun.title) })
      .click()
  })
  return fresh
}

describe('AutomationsPage run navigation', () => {
  it('keeps the runs dashboard open when the user backs out of a pending read', async () => {
    const { container, oldRun } = await loadCachedHistory()
    const newRun = makeRun({ id: 'run-27', title: 'Nightly run 27' })
    const fresh = await openDashboardRun(container, newRun, oldRun)
    const breadcrumb = within(container).getByRole('navigation', {
      name: 'Automations breadcrumb'
    })

    await act(async () => within(breadcrumb).getByRole('button', { name: 'Runs' }).click())
    await act(async () => fresh.resolve([newRun, oldRun]))

    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    expect(within(container).getByRole('textbox', { name: 'Search runs…' })).toBeTruthy()
    expect(container.querySelector('[aria-label="Run context"]')).toBeNull()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
  })

  it('returns to automation details when cancelling a workspace run link from there', async () => {
    const { container, rerender, automation, oldRun } = await loadCachedHistory()
    await act(async () => within(container).getByRole('button', { name: 'Nightly' }).click())
    const fresh = Promise.withResolvers<AutomationRun[]>()
    api.automations.listRuns.mockReturnValue(fresh.promise)
    mocks.state.pendingAutomationRunNavigation = {
      automationId: automation.id,
      runId: oldRun.id
    }
    await rerender()

    expect(within(container).getByRole('status')).toBeTruthy()
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    await act(async () => fresh.resolve([oldRun]))

    expect(within(container).getByTestId('detail-pane')).toBeTruthy()
    expect(container.querySelector('[aria-label="Run context"]')).toBeNull()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
  })

  it('shows the history error when opening a run from the dashboard fails', async () => {
    const { container, oldRun } = await loadCachedHistory()
    const newRun = makeRun({ id: 'run-27', title: 'Nightly run 27' })
    const fresh = await openDashboardRun(container, newRun, oldRun)

    await act(async () => fresh.reject(new Error('Host disconnected')))

    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="detail-pane"]')).not.toBeNull()
    expect(mocks.detailPane?.selectedRunsNotice?.message).toContain('Host disconnected')
  })
})
