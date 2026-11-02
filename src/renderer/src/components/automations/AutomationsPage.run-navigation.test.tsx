// @vitest-environment happy-dom

import { act } from 'react'
import { within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  runtimeHost,
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
  it('opens the automation overview without rereading its cached history', async () => {
    const { container, rerender, automation, oldRun } = await loadCachedHistory()
    const fresh = Promise.withResolvers<AutomationRun[]>()
    api.automations.listRuns.mockClear()
    api.automations.listRuns.mockReturnValue(fresh.promise)
    mocks.state.pendingAutomationRunNavigation = {
      automationId: automation.id,
      runId: null
    }

    await rerender()
    await settleHostQueries()

    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    expect(within(container).getByTestId('detail-pane')).toBeTruthy()
    expect(mocks.detailPane?.selectedRuns).toEqual([oldRun])
    expect(api.automations.listRuns).not.toHaveBeenCalled()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
    await act(async () => fresh.resolve([oldRun]))
  })

  it('opens a new dashboard run after refreshing an already-cached automation history', async () => {
    const { container, oldRun } = await loadCachedHistory()
    await act(async () => within(container).getByRole('button', { name: 'Nightly' }).click())
    expect(within(container).getByTestId('detail-run-count').textContent).toBe('1')
    expect(mocks.detailPane?.selectedRuns.map((run) => run.id)).toEqual([oldRun.id])
    const breadcrumb = within(container).getByRole('navigation', {
      name: 'Automations breadcrumb'
    })
    await act(async () => within(breadcrumb).getByRole('button', { name: 'Automations' }).click())
    const newRun = makeRun({
      id: 'run-27',
      runNumber: 27,
      title: 'Nightly run 27',
      outputSnapshot: {
        format: 'plain_text',
        content: 'Fresh run output',
        capturedAt: 20,
        truncated: false
      }
    })
    const fresh = await openDashboardRun(container, newRun, oldRun)

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(mocks.state.pendingAutomationRunNavigation).toMatchObject({ runId: newRun.id })
    expect(within(container).getByRole('status').textContent).toContain('Loading runs')
    expect(within(container).queryByText('Fresh run output')).toBeNull()
    await act(async () => fresh.resolve([newRun, oldRun]))

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    expect(within(container).queryByRole('status')).toBeNull()
    expect(within(container).getByText('Fresh run output')).toBeTruthy()
    expect(within(container).getByRole('button', { name: 'Back to runs' })).toBeTruthy()
  })

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

  it('shows loading for a workspace run link and cancels it with Escape', async () => {
    const { container, rerender, automation, oldRun } = await loadCachedHistory()
    const fresh = Promise.withResolvers<AutomationRun[]>()
    api.automations.listRuns.mockReturnValue(fresh.promise)
    mocks.state.pendingAutomationRunNavigation = {
      automationId: automation.id,
      runId: oldRun.id
    }

    await rerender()

    expect(within(container).getByRole('status').textContent).toContain('Loading runs')
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    await act(async () => fresh.resolve([oldRun]))

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

  it('reports a missing run only after the fresh history confirms its absence', async () => {
    const { rerender, automation, oldRun } = await loadCachedHistory()
    const fresh = Promise.withResolvers<AutomationRun[]>()
    api.automations.listRuns.mockReturnValue(fresh.promise)
    mocks.state.pendingAutomationRunNavigation = {
      automationId: automation.id,
      runId: 'pruned-run'
    }

    await rerender()

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(mocks.setPendingRunNavigation).not.toHaveBeenCalled()
    await act(async () => fresh.resolve([oldRun]))

    expect(mocks.toastMessage).toHaveBeenCalledWith('Run history no longer available.')
    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
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

  it.each(['all', 'desktop'] as const)(
    'resolves a workspace run link on its host with colliding ids under the %s filter',
    async (filter) => {
      const remoteRun = makeRun({
        id: 'run-26',
        outputSnapshot: {
          format: 'plain_text',
          content: 'Output from the selected remote host',
          capturedAt: 20,
          truncated: false
        }
      })
      runtimeHost([makeAutomation({ name: 'Remote nightly' })], [remoteRun])
      if (filter === 'desktop') {
        mocks.state.automationHostFilter = {
          kind: 'host',
          host: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
        }
      }
      mocks.setAutomationHostFilter.mockImplementation((next) => {
        mocks.state.automationHostFilter = next
      })
      const { container, rerender, automation } = await loadCachedHistory()
      const fresh = Promise.withResolvers<{ runs: AutomationRun[] }>()
      const originalRpc = mocks.callRuntimeRpc.getMockImplementation()
      mocks.callRuntimeRpc.mockImplementation(
        (target: unknown, method: unknown, ...args: unknown[]) => {
          if (
            method === 'automation.runs' &&
            typeof target === 'object' &&
            target !== null &&
            'kind' in target &&
            target.kind === 'environment' &&
            'environmentId' in target &&
            target.environmentId === 'gpu'
          ) {
            return fresh.promise
          }
          return originalRpc?.(target, method, ...args)
        }
      )
      await act(async () => {
        mocks.state.pendingAutomationRunNavigation = {
          automationId: automation.id,
          runId: remoteRun.id,
          hostId: 'runtime:gpu'
        }
      })
      await rerender()
      await rerender()

      expect(mocks.toastMessage).not.toHaveBeenCalled()
      expect(mocks.state.pendingAutomationRunNavigation).not.toBeNull()
      await act(async () => fresh.resolve({ runs: [remoteRun] }))

      expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
      expect(container.textContent).toContain('Output from the selected remote host')
      expect(mocks.toastMessage).not.toHaveBeenCalled()
    }
  )
})
