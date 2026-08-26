// @vitest-environment happy-dom

/**
 * What the page refetches, and whose row survives it.
 *
 * A refresh reaches one authority at a time, so re-deriving the selection or the
 * run history from its answer drops — or worse, mislabels — every row another
 * host holds. Under All hosts that is the normal case, not the edge case.
 */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  refreshOnFocus,
  renderPage,
  RUNTIME_SELF_FILTER,
  runtimeHost,
  scopedList,
  SELF_PRECONDITION,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, makeRun } from './automations-page-fixtures'

installAutomationsPageHarness()

async function openAutomationRow(container: HTMLElement, name: string): Promise<void> {
  const row = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-testid="automation-row"]')
  ].find((candidate) => candidate.textContent === name)
  expect(row).toBeTruthy()
  await act(async () => row?.click())
  await settleHostQueries()
}

describe('AutomationsPage refresh', () => {
  it('never asks a host for every run it has retained', async () => {
    const run = makeRun({ id: 'run-1', automationId: 'a-1' })
    api.automations.list.mockResolvedValue([makeAutomation({ id: 'a-1' })])
    api.automations.listRuns.mockResolvedValue([run])

    await renderPage()

    // Every call names one automation: a host's whole history is never the
    // page's to hold, and asking for it made the cost scale with retention.
    for (const [args] of api.automations.listRuns.mock.calls) {
      expect(args?.automationId).toBeTruthy()
    }
  })

  it('reads row usage from the authority projection rather than from runs', async () => {
    const usageSummary = {
      knownRuns: 2,
      unavailableRuns: 0,
      inputTokens: 900,
      outputTokens: 300,
      cacheTokens: 0,
      reasoningOutputTokens: 34,
      totalTokens: 1234,
      estimatedCostUsd: 0.5
    }
    api.automations.listScoped.mockResolvedValue({
      automations: [makeAutomation({ id: 'a-1' })],
      items: [{ automationId: 'a-1', selector: { kind: 'self' }, usageSummary }],
      orphanCount: 0
    })

    await renderPage()

    expect(mocks.listPanel?.filteredRows[0]?.usageSummary).toEqual(usageSummary)
  })

  it('does not re-list through the active runtime just because one is selected', async () => {
    mocks.state.settings = {
      ...(mocks.state.settings as Record<string, unknown>),
      activeRuntimeEnvironmentId: 'gpu'
    }

    await renderPage()

    // The ambient runtime is not evidence about any row. The desktop answers
    // the unscoped arm; a runtime's rows arrive through its own catalog entry.
    expect(api.automations.list).toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'gpu' },
      'automation.list',
      undefined,
      { timeoutMs: 15_000 }
    )
  })

  // The manual All-hosts refresh: without a control wired to it, a host whose
  // entry stopped short has nothing that re-queries it.
  it('re-queries every host in view from the header refresh action', async () => {
    const { container } = await renderPage()
    api.automations.listScoped.mockClear()

    const refresh = container.querySelector<HTMLElement>('[aria-label="Refresh automations"]')
    expect(refresh).not.toBeNull()
    await act(async () => refresh?.click())

    // Inside the 30s TTL, so only a manual refresh can produce this call.
    expect(api.automations.listScoped).toHaveBeenCalledWith({ selector: { kind: 'self' } })
  })

  it('does not re-run the whole refresh when the settings identity changes', async () => {
    const { rerender } = await renderPage()
    expect(api.automations.list).toHaveBeenCalledTimes(1)

    mocks.state.settings = { ...(mocks.state.settings as Record<string, unknown>) }
    await rerender()

    // Settings no longer aim the list, so a new settings object is not a reason
    // to re-fetch every host.
    expect(api.automations.list).toHaveBeenCalledTimes(1)
  })
})

describe('AutomationsPage selection', () => {
  it('loads the first automation into the detail pane and fetches its runs', async () => {
    const run = makeRun({ id: 'run-1', automationId: 'a-1' })
    api.automations.list.mockResolvedValue([makeAutomation({ id: 'a-1', name: 'Nightly' })])
    api.automations.listRuns.mockImplementation(async (args?: { automationId?: string }) =>
      args?.automationId === 'a-1' ? [run] : []
    )

    const { container } = await renderPage()
    await openAutomationRow(container, 'Nightly')

    // One fenced read, owned by the row's own host: the page-level refresh used
    // to fetch this history too, unfenced and always against the desktop.
    expect(api.automations.listRuns).toHaveBeenCalledWith({
      automationId: 'a-1',
      expectedOwner: SELF_PRECONDITION
    })
    expect(container.querySelector('[data-testid="detail-name"]')?.textContent).toBe('Nightly')
    expect(mocks.detailPane?.selectedRuns).toEqual([run])
  })

  it('fetches the newly selected automation runs when the selection changes', async () => {
    scopedList([
      makeAutomation({ id: 'a-1', name: 'Nightly' }),
      makeAutomation({ id: 'a-2', name: 'Weekly' })
    ])

    const { container, rerender } = await renderPage()
    api.automations.listRuns.mockClear()

    mocks.state.selectedAutomationId = 'a-2'
    await rerender()
    await openAutomationRow(container, 'Weekly')

    // The history read carries the row's fence too: a read against a host that
    // no longer owns the record is refused rather than answered from the wrong one.
    expect(api.automations.listRuns).toHaveBeenCalledWith({
      automationId: 'a-2',
      expectedOwner: SELF_PRECONDITION
    })
    expect(mocks.detailPane?.selected?.id).toBe('a-2')
  })
})

describe('AutomationsPage multi-host selection', () => {
  it('keeps a selection that lives on another host when the window regains focus', async () => {
    runtimeHost([makeAutomation({ id: 'a-remote', name: 'Remote nightly' })], [])
    const desktop = makeAutomation({ id: 'a-desktop', name: 'Desktop nightly' })
    scopedList([desktop])
    api.automations.list.mockResolvedValue([desktop])
    const setSelectedAutomationId = vi.fn((id: string | null) => {
      mocks.state.selectedAutomationId = id
    })
    mocks.state.selectedAutomationId = 'a-remote'
    mocks.state.setSelectedAutomationId = setSelectedAutomationId

    const { container, rerender } = await renderPage()
    await settleHostQueries()
    await refreshOnFocus()
    await rerender()

    // The refresh reaches one authority, so re-deriving the selection from its
    // list dropped every row that authority does not hold.
    expect(setSelectedAutomationId).not.toHaveBeenCalled()
    await openAutomationRow(container, 'Remote nightly')
    expect(container.querySelector('[data-testid="detail-name"]')?.textContent).toBe(
      'Remote nightly'
    )
  })

  it('shows the selected host’s runs when another authority holds the same id', async () => {
    runtimeHost(
      [makeAutomation({ id: 'a-1', name: 'Remote nightly' })],
      [makeRun({ id: 'run-remote', automationId: 'a-1' })]
    )
    // Same ID, different machine: legal, because an ID is unique only inside
    // one authority. The desktop is the host the page can always reach.
    api.automations.list.mockResolvedValue([makeAutomation({ id: 'a-1', name: 'Desktop nightly' })])
    api.automations.listRuns.mockResolvedValue([
      makeRun({ id: 'run-desktop', automationId: 'a-1' })
    ])
    scopedList([])
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    mocks.state.selectedAutomationId = 'a-1'

    const { container } = await renderPage()
    await settleHostQueries()
    await refreshOnFocus()
    await openAutomationRow(container, 'Remote nightly')

    expect(mocks.detailPane?.selected?.name).toBe('Remote nightly')
    expect(mocks.detailPane?.selectedRuns.map((run) => run.id)).toEqual(['run-remote'])
  })

  it('keeps both authorities’ rows on screen and selectable under All hosts', async () => {
    runtimeHost(
      [makeAutomation({ id: 'a-1', name: 'Remote nightly' })],
      [makeRun({ id: 'run-remote', automationId: 'a-1' })]
    )
    scopedList([makeAutomation({ id: 'a-1', name: 'Desktop nightly' })])
    // The stored id names the record; only the row key can say whose copy.
    mocks.state.selectedAutomationId = 'a-1'

    const { container } = await renderPage()
    await settleHostQueries()

    // Two stored records, not one row and a silent drop into #44's empty state.
    expect(
      [...container.querySelectorAll('[data-testid="automation-row"]')].map(
        (row) => row.textContent
      )
    ).toEqual(['Desktop nightly', 'Remote nightly'])

    const remote = mocks.listPanel?.filteredRows.find(
      (row) => row.automation.name === 'Remote nightly'
    )
    await act(async () => {
      mocks.listPanel?.selectAutomationRow(remote?.key ?? '')
    })

    expect(mocks.detailPane?.selected?.name).toBe('Remote nightly')
  })
})
