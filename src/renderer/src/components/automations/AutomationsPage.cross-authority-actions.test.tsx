// @vitest-environment happy-dom

/**
 * Row actions under a cross-authority ID collision.
 *
 * Two authorities may legitimately hold the same automation ID, so the copy the
 * user acted on is named by its row, never by that ID. These pin the case a
 * bare-ID owner map cannot express: the desktop's copy is listed first and the
 * runtime's copy is listed second, so anything keyed by the ID alone answers
 * with the runtime's owner and sends the desktop's row to the wrong machine.
 */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  runtimeHost,
  scopedList,
  SELF_PRECONDITION,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation } from './automations-page-fixtures'

installAutomationsPageHarness()

/** Desktop and runtime both hold `a-1`; the runtime's row is committed last. */
async function collidingHosts(): Promise<void> {
  runtimeHost([makeAutomation({ id: 'a-1', name: 'Remote nightly' })], [])
  const desktop = makeAutomation({ id: 'a-1', name: 'Desktop nightly' })
  scopedList([desktop])
  api.automations.list.mockResolvedValue([desktop])
  mocks.state.selectedAutomationId = 'a-1'
}

function selectDesktopRow(): string {
  const row = mocks.listPanel?.filteredRows.find(
    (candidate) => candidate.automation.name === 'Desktop nightly'
  )
  expect(row).toBeDefined()
  return row?.key ?? ''
}

/** Every runtime-environment automation call, so a misrouted action cannot hide
 *  in the noise. Local-target calls are the desktop authority's own and excluded. */
function runtimeAutomationCalls(): string[] {
  return mocks.callRuntimeRpc.mock.calls
    .filter((call) => (call[0] as { kind?: string } | null)?.kind === 'environment')
    .map((call) => String(call[1]))
    .filter((method) => method.startsWith('automation.'))
}

describe('AutomationsPage row actions under a colliding automation id', () => {
  it('names the selected row’s own host, not the desktop that listed it', async () => {
    await collidingHosts()
    await renderPage()
    await settleHostQueries()

    const remote = mocks.listPanel?.filteredRows.find(
      (candidate) => candidate.automation.name === 'Remote nightly'
    )
    await act(async () => {
      mocks.listPanel?.selectAutomationRow(remote?.key ?? '')
    })

    // The runtime copy's own execution target reads `local` — local to that
    // server — so only the row's catalog entry can name the host on the detail view.
    expect(mocks.detailPane?.selected?.name).toBe('Remote nightly')
    expect(mocks.detailPane?.selectedHostEntry?.authorityLabel).toBe('GPU box')
  })

  it('runs the selected desktop row on the desktop, not on the runtime holding the same id', async () => {
    await collidingHosts()
    const { container } = await renderPage()
    await settleHostQueries()
    expect(
      [...container.querySelectorAll('[data-testid="automation-row"]')].map(
        (row) => row.textContent
      )
    ).toEqual(['Desktop nightly', 'Remote nightly'])

    await act(async () => {
      mocks.listPanel?.selectAutomationRow(selectDesktopRow())
    })
    expect(mocks.detailPane?.selected?.name).toBe('Desktop nightly')
    mocks.callRuntimeRpc.mockClear()
    await act(async () => {
      mocks.detailPane?.runNow(mocks.detailPane.selected!)
    })

    expect(runtimeAutomationCalls()).not.toContain('automation.runNow')
    expect(api.automations.runNow).toHaveBeenCalledWith({
      id: 'a-1',
      expectedOwner: SELF_PRECONDITION
    })
  })

  it('pauses the selected desktop row on the desktop', async () => {
    await collidingHosts()
    await renderPage()
    await settleHostQueries()

    await act(async () => {
      mocks.listPanel?.selectAutomationRow(selectDesktopRow())
    })
    mocks.callRuntimeRpc.mockClear()
    await act(async () => {
      mocks.detailPane?.toggleAutomation(mocks.detailPane.selected!)
    })

    expect(api.automations.update).toHaveBeenCalledWith({
      id: 'a-1',
      updates: { enabled: false },
      expectedOwner: SELF_PRECONDITION,
      destination: undefined
    })
    expect(runtimeAutomationCalls()).not.toContain('automation.update')
  })

  it('deletes the selected desktop row on the desktop', async () => {
    await collidingHosts()
    await renderPage()
    await settleHostQueries()

    await act(async () => {
      mocks.listPanel?.selectAutomationRow(selectDesktopRow())
    })
    await act(async () => {
      mocks.detailPane?.requestDeleteAutomation(mocks.detailPane.selected!)
    })
    mocks.callRuntimeRpc.mockClear()
    await act(async () => {
      mocks.deleteDialog?.onConfirm()
    })

    expect(api.automations.delete).toHaveBeenCalledWith({
      id: 'a-1',
      expectedOwner: SELF_PRECONDITION
    })
    expect(runtimeAutomationCalls()).not.toContain('automation.delete')
  })
})
