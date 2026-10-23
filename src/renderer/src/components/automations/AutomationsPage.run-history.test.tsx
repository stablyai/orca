// @vitest-environment happy-dom

import { act } from 'react'
import { within } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  renderPage,
  SELF_PRECONDITION,
  settleHostQueries
} from './automations-page-test-harness'
import { makeRun } from './automations-page-fixtures'
import type * as DetailPaneModule from './AutomationsDetailPane'

// Keep the real detail controls, count, and history while reusing the page's API fixture.
const { AutomationsDetailPane } =
  await vi.importActual<typeof DetailPaneModule>('./AutomationsDetailPane')

vi.mock('@tanstack/react-virtual', async () => {
  const { createVirtualizerStub } = await import('./virtualizer-test-stub')
  return { useVirtualizer: createVirtualizerStub() }
})

installAutomationsPageHarness()

describe('AutomationsPage run history through detail controls', () => {
  it.each(['new run', 'status change'] as const)(
    'recovers a missed %s event after refreshing and reopening the same automation',
    async (change) => {
      const user = userEvent.setup()
      api.automations.listRuns.mockResolvedValue(
        change === 'new run' ? [] : [makeRun({ status: 'dispatched' })]
      )
      const { container, rerender } = await renderPage({
        detailPaneComponent: AutomationsDetailPane
      })
      const page = within(container)
      await act(async () => user.click(page.getByRole('button', { name: 'Nightly' })))
      await settleHostQueries()
      await act(async () =>
        user.click(page.getByRole('tab', { name: change === 'new run' ? 'Runs 0' : 'Runs 1' }))
      )
      if (change === 'new run') {
        expect(page.getByText('No runs yet.')).toBeTruthy()
      } else {
        expect(container.querySelector('[data-automation-run-id="run-1"]')?.textContent).toContain(
          'Launched'
        )
      }
      const historyReads = api.automations.listRuns.mock.calls.length
      api.automations.listRuns.mockResolvedValue([makeRun({ status: 'completed' })])

      await act(async () => user.click(page.getByRole('button', { name: 'All automations' })))
      await act(async () => user.click(page.getByRole('button', { name: 'Refresh automations' })))
      await settleHostQueries()
      await act(async () => user.click(page.getByRole('button', { name: 'Nightly' })))
      await act(async () => user.click(page.getByRole('tab', { name: 'Runs 1' })))
      await rerender()
      await settleHostQueries()

      expect(page.queryByText('No runs yet.')).toBeNull()
      expect(page.getByText('1 run · 1 completed')).toBeTruthy()
      expect(container.querySelector('[data-automation-run-id="run-1"]')?.textContent).toContain(
        'Done'
      )
      expect(api.automations.listRuns).toHaveBeenCalledTimes(historyReads + 1)
    }
  )

  it.each([
    { status: 'completed', label: 'Done', completed: 1 },
    { status: 'skipped_unavailable', label: 'Unavailable', completed: 0 }
  ] as const)('shows a saved $status run after Run Now without refreshing', async (outcome) => {
    const user = userEvent.setup()
    const { container } = await renderPage({ detailPaneComponent: AutomationsDetailPane })
    const page = within(container)
    await act(async () => user.click(page.getByRole('button', { name: 'Nightly' })))
    await settleHostQueries()
    await act(async () => user.click(page.getByRole('tab', { name: 'Runs 0' })))
    expect(page.getByText('No runs yet.')).toBeTruthy()
    await act(async () => user.click(page.getByRole('tab', { name: 'Overview' })))
    const historyReads = api.automations.listRuns.mock.calls.length
    const saved = makeRun({
      status: outcome.status,
      trigger: 'manual',
      error: outcome.status === 'skipped_unavailable' ? 'Host capacity reached' : null
    })
    api.automations.runNow.mockImplementationOnce(async () => {
      api.automations.listRuns.mockResolvedValue([saved])
      return saved
    })

    await act(async () => user.click(page.getByRole('button', { name: 'Run Now' })))
    await settleHostQueries()

    expect(api.automations.runNow).toHaveBeenCalledExactlyOnceWith({
      id: 'a-1',
      expectedOwner: SELF_PRECONDITION
    })
    await act(async () => user.click(page.getByRole('tab', { name: 'Runs 1' })))
    expect(page.queryByText('No runs yet.')).toBeNull()
    expect(page.getByText(`1 run · ${outcome.completed} completed`)).toBeTruthy()
    const row = container.querySelector('[data-automation-run-id="run-1"]')
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain(outcome.label)
    expect(api.automations.listRuns).toHaveBeenCalledTimes(historyReads + 1)
  })

  it('shows the saved rerun when returning from the original run’s details', async () => {
    const user = userEvent.setup()
    const original = makeRun({ status: 'dispatch_failed' })
    const saved = makeRun({ id: 'run-2', trigger: 'manual' })
    api.automations.listRuns.mockResolvedValue([original])
    const { container } = await renderPage({ detailPaneComponent: AutomationsDetailPane })
    const page = within(container)
    await act(async () => user.click(page.getByRole('button', { name: 'Nightly' })))
    await settleHostQueries()
    await act(async () => user.click(page.getByRole('tab', { name: 'Runs 1' })))
    await act(async () => user.click(page.getByRole('button', { name: /Failed/ })))
    const historyReads = api.automations.listRuns.mock.calls.length
    api.automations.runNow.mockImplementationOnce(async () => {
      api.automations.listRuns.mockResolvedValue([saved, original])
      return saved
    })

    await act(async () => {
      await user.click(page.getByRole('button', { name: 'Rerun' }))
      await new Promise((resolve) => setTimeout(resolve, 850))
    })
    await settleHostQueries()

    expect(page.getByRole('button', { name: 'Rerun' })).toBeTruthy()
    await act(async () => user.click(page.getByRole('button', { name: 'Back to runs' })))
    expect(page.getByRole('tab', { name: 'Runs 2', selected: true })).toBeTruthy()
    expect(page.getByText('2 runs · 1 completed')).toBeTruthy()
    expect(container.querySelector('[data-automation-run-id="run-2"]')?.textContent).toContain(
      'Done'
    )
    expect(api.automations.runNow).toHaveBeenCalledTimes(1)
    expect(api.automations.listRuns).toHaveBeenCalledTimes(historyReads + 1)
  })

  it.each(['failed read', 'pruned run'] as const)(
    'keeps Back usable after rerun history returns a %s',
    async (outcome) => {
      const user = userEvent.setup()
      const original = makeRun({ status: 'dispatch_failed', error: 'Original launch failed' })
      const saved = makeRun({ id: 'run-2', trigger: 'manual' })
      api.automations.listRuns.mockResolvedValue([original])
      const { container } = await renderPage({ detailPaneComponent: AutomationsDetailPane })
      const page = within(container)
      await act(async () => user.click(page.getByRole('button', { name: 'Nightly' })))
      await settleHostQueries()
      await act(async () => user.click(page.getByRole('tab', { name: 'Runs 1' })))
      await act(async () => user.click(page.getByRole('button', { name: /Failed/ })))
      api.automations.runNow.mockImplementationOnce(async () => {
        if (outcome === 'failed read') {
          api.automations.listRuns.mockRejectedValue(new Error('History host unreachable'))
        } else {
          api.automations.listRuns.mockResolvedValue([saved])
        }
        return saved
      })

      await act(async () => user.click(page.getByRole('button', { name: 'Rerun' })))
      await settleHostQueries()

      expect(page.queryByLabelText('Loading automations')).toBeNull()
      expect(page.getByRole('alert').textContent).toContain(
        outcome === 'failed read' ? 'History host unreachable' : 'Run history no longer available.'
      )
      expect(page.getByRole('button', { name: 'Back to runs' })).toBeTruthy()
      if (outcome === 'pruned run') {
        expect(page.queryByRole('button', { name: 'Retry' })).toBeNull()
        await act(async () => user.click(page.getByRole('button', { name: 'Back to runs' })))
        expect(page.getByRole('tab', { name: 'Runs 1', selected: true })).toBeTruthy()
        return
      }
      expect(page.getByText('Original launch failed')).toBeTruthy()
      const historyReads = api.automations.listRuns.mock.calls.length
      const retry = Promise.withResolvers<ReturnType<typeof makeRun>[]>()
      api.automations.listRuns.mockReturnValueOnce(retry.promise)

      await act(async () => user.click(page.getByRole('button', { name: 'Retry' })))
      expect(page.queryByRole('alert')).toBeNull()
      expect(page.getByText('Original launch failed')).toBeTruthy()
      await act(async () => retry.resolve([saved, original]))
      await settleHostQueries()

      expect(api.automations.listRuns).toHaveBeenCalledTimes(historyReads + 1)
      expect(page.getByText('Original launch failed')).toBeTruthy()
      expect(page.queryByRole('alert')).toBeNull()
      await act(async () => user.click(page.getByRole('button', { name: 'Back to runs' })))
      expect(page.getByRole('tab', { name: 'Runs 2', selected: true })).toBeTruthy()
    }
  )
})
