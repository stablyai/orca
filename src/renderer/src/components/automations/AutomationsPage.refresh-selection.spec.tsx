// @vitest-environment happy-dom

/** Refresh reaches one authority at a time; deriving selection/history from that answer would drop or mislabel other hosts’ rows under All hosts. */

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
import { listedRows } from './automations-page-listed-items'
import { makeAutomation, makeRun } from './automations-page-fixtures'

async function openAutomationRow(container: HTMLElement, name: string): Promise<void> {
  const row = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-testid="automation-row"]')
  ].find((candidate) => candidate.textContent === name)
  expect(row).toBeTruthy()
  await act(async () => row?.click())
  await settleHostQueries()
}

describe('AutomationsPage selection', () => {
  installAutomationsPageHarness()

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

    // Fence history reads too so moved rows refuse rather than answer from a former host.
    expect(api.automations.listRuns).toHaveBeenCalledWith({
      automationId: 'a-2',
      expectedOwner: SELF_PRECONDITION,
      preview: true
    })
    expect(mocks.detailPane?.selected?.id).toBe('a-2')
  })
})

describe('AutomationsPage multi-host selection', () => {
  installAutomationsPageHarness()

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

    // One authority’s refresh cannot decide whether another authority’s selected row still exists.
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
    // IDs can collide across authorities; desktop remains independently reachable.
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

    const remote = listedRows().find((row) => row.automation.name === 'Remote nightly')
    await act(async () => {
      mocks.listPanel?.selectAutomationRow(remote?.key ?? '')
    })

    expect(mocks.detailPane?.selected?.name).toBe('Remote nightly')
  })
})
