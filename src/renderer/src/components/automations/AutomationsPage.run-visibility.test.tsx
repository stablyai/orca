// @vitest-environment happy-dom

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  emitAutomationsChangedWindowEvent,
  type AutomationsChangedWindowDetail
} from '@/lib/automations-changed-window-event'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  RUNTIME_ID,
  runtimeHost,
  settleHostQueries
} from './automations-page-test-harness'
import { listedRow, listedRows } from './automations-page-listed-items'
import { makeAutomation, makeRun } from './automations-page-fixtures'

async function openDetail(): Promise<void> {
  await act(async () => mocks.listPanel?.selectAutomationRow(listedRow('a-1').key))
  await settleHostQueries()
}

async function openRun(container: HTMLElement, run: AutomationRun): Promise<HTMLButtonElement> {
  await act(async () => mocks.detailPane?.openAutomationRunPage(run))
  const rerun = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Rerun'
  )
  if (!rerun) {
    throw new Error('Rerun button missing')
  }
  return rerun
}

describe('AutomationsPage run visibility', () => {
  installAutomationsPageHarness()

  it('does not reload another host’s selected copy when an in-flight Run Now completes', async () => {
    runtimeHost([makeAutomation({ name: 'Remote nightly' })], [makeRun({ id: 'remote-run' })])
    mocks.state.setSelectedAutomationId = vi.fn((id: string | null) => {
      mocks.state.selectedAutomationId = id
    })
    const { rerender } = await renderPage()
    await settleHostQueries()
    const remote = listedRows().find((row) => row.automation.name === 'Remote nightly')
    expect(remote).toBeDefined()
    let finishRun: (run: AutomationRun) => void = () => {
      throw new Error('Run Now not started')
    }
    api.automations.runNow.mockImplementationOnce(
      () => new Promise<AutomationRun>((resolve) => (finishRun = resolve))
    )
    await act(async () => mocks.listPanel?.runNow(listedRow('a-1')))
    await act(async () => mocks.listPanel?.selectAutomationRow(remote?.key ?? ''))
    await settleHostQueries()
    const readsBefore = mocks.callRuntimeRpc.mock.calls.filter(
      ([, method]) => method === 'automation.runs'
    ).length
    expect(mocks.detailPane?.selected?.name).toBe('Remote nightly')

    await act(async () => finishRun(makeRun()))
    await settleHostQueries()
    await rerender()

    expect(mocks.detailPane?.selected?.name).toBe('Remote nightly')
    expect(mocks.detailPane?.selectedRuns.map((run) => run.id)).toEqual(['remote-run'])
    expect(
      mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'automation.runs')
    ).toHaveLength(readsBefore)
  })

  it.each(
    ['Run Now', 'Rerun'].flatMap((action) =>
      ['UI hydration fails', 'list loading stalls'].map((problem) => ({ action, problem }))
    )
  )('reloads saved history after $action when $problem', async ({ action, problem }) => {
    const original = makeRun({ status: 'dispatch_failed' })
    const saved = makeRun({ id: 'run-2', trigger: 'manual' })
    api.automations.listRuns.mockResolvedValue([original])
    const { container } = await renderPage()
    await openDetail()
    const rerun = action === 'Rerun' ? await openRun(container, original) : null
    const readsBefore = api.automations.listRuns.mock.calls.length
    api.automations.runNow.mockImplementationOnce(async () => {
      api.automations.listRuns.mockResolvedValue([saved, original])
      return saved
    })
    if (problem === 'UI hydration fails') {
      api.ui.get.mockRejectedValueOnce(new Error('UI hydration failed'))
    } else {
      api.automations.list.mockImplementationOnce(() => new Promise(() => undefined))
    }

    await act(async () => {
      if (rerun) {
        rerun.click()
      } else {
        mocks.detailPane?.runNow(makeAutomation())
      }
    })
    await settleHostQueries()

    expect(api.automations.runNow).toHaveBeenCalledTimes(1)
    expect(api.ui.get).toHaveBeenCalledTimes(1)
    expect(api.automations.listRuns).toHaveBeenCalledTimes(readsBefore + 1)
    if (rerun) {
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Back to runs"]')?.click()
      )
    }
    expect(mocks.detailPane?.selectedRuns).toEqual([saved, original])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each<{
    name: string
    detail: AutomationsChangedWindowDetail
    reads: number
  }>([
    { name: 'run status', detail: { selector: { kind: 'self' }, reason: 'run' }, reads: 1 },
    { name: 'run usage', detail: { selector: { kind: 'self' }, reason: 'usage' }, reads: 1 },
    { name: 'legacy authority event', detail: {}, reads: 1 },
    { name: 'another authority', detail: { environmentId: 'other', reason: 'run' }, reads: 0 },
    {
      name: 'another SSH target',
      detail: { selector: { kind: 'ssh', targetId: 'other' }, reason: 'run' },
      reads: 0
    }
  ])('refreshes selected history only for its host: $name', async ({ detail, reads }) => {
    const dispatched = makeRun({ status: 'dispatched' })
    const completed = makeRun({ status: 'completed' })
    api.automations.listRuns.mockResolvedValue([dispatched])
    const { rerender } = await renderPage()
    await openDetail()
    const readsBefore = api.automations.listRuns.mock.calls.length
    api.automations.listRuns.mockResolvedValue([completed])

    await act(async () => {
      emitAutomationsChangedWindowEvent(detail)
      emitAutomationsChangedWindowEvent(detail)
    })
    await settleHostQueries()
    await rerender()

    expect(api.automations.listRuns).toHaveBeenCalledTimes(readsBefore + reads)
    expect(mocks.detailPane?.selectedRuns).toEqual(reads ? [completed] : [dispatched])
  })

  it('refreshes a selected runtime’s history without asking it about desktop events', async () => {
    const automation = makeAutomation({ name: 'Remote nightly' })
    const dispatched = makeRun({ status: 'dispatched' })
    const completed = makeRun({ status: 'completed' })
    runtimeHost([automation], [dispatched])
    mocks.state.selectedAutomationId = automation.id
    await renderPage()
    const remote = listedRows().find((row) => row.automation.name === automation.name)
    if (!remote) {
      throw new Error('Remote automation missing')
    }
    await act(async () => mocks.listPanel?.selectAutomationRow(remote.key))
    await settleHostQueries()
    expect(mocks.detailPane?.selected?.name).toBe('Remote nightly')
    const runtimeReads = (): number =>
      mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'automation.runs').length
    const readsBefore = runtimeReads()
    runtimeHost([automation], [completed])

    await act(async () => emitAutomationsChangedWindowEvent({ reason: 'run' }))
    await settleHostQueries()
    expect(runtimeReads()).toBe(readsBefore)
    expect(mocks.detailPane?.selectedRuns).toEqual([dispatched])

    await act(async () =>
      emitAutomationsChangedWindowEvent({ environmentId: RUNTIME_ID, reason: 'run' })
    )
    await settleHostQueries()
    expect(runtimeReads()).toBe(readsBefore + 1)
    expect(mocks.detailPane?.selectedRuns).toEqual([completed])
  })

  it('refreshes the selected runtime history without reading desktop history', async () => {
    const automation = makeAutomation({ name: 'Remote nightly' })
    const dispatched = makeRun({ status: 'dispatched' })
    const completed = makeRun({ status: 'completed' })
    runtimeHost([automation], [dispatched])
    mocks.state.selectedAutomationId = automation.id
    const { container } = await renderPage()
    await settleHostQueries()
    const remote = listedRows().find((row) => row.automation.name === automation.name)
    if (!remote) {
      throw new Error('Remote automation missing')
    }
    await act(async () => mocks.listPanel?.selectAutomationRow(remote.key))
    await settleHostQueries()
    expect(mocks.detailPane?.selectedRuns).toEqual([dispatched])
    const desktopReads = api.automations.listRuns.mock.calls.length
    const runtimeReads = (): number =>
      mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'automation.runs').length
    const readsBefore = runtimeReads()
    mocks.state.runtimeAnswers = { automations: [automation], runs: [completed] }

    await act(async () => mocks.detailPane?.onBackToList())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh automations"]')?.click()
    )
    await settleHostQueries()
    await act(async () => mocks.listPanel?.selectAutomationRow(remote.key))
    await settleHostQueries()

    expect(mocks.detailPane?.selected?.name).toBe(automation.name)
    expect(mocks.detailPane?.selectedRuns).toEqual([completed])
    expect(runtimeReads()).toBe(readsBefore + 1)
    expect(api.automations.listRuns).toHaveBeenCalledTimes(desktopReads)
  })

  it('ignores an older history response after a newer host event has settled', async () => {
    const { rerender } = await renderPage()
    await openDetail()
    let finishOldRead: (runs: AutomationRun[]) => void = () => {
      throw new Error('History read not started')
    }
    api.automations.listRuns.mockImplementationOnce(
      () => new Promise<AutomationRun[]>((resolve) => (finishOldRead = resolve))
    )
    await act(async () => emitAutomationsChangedWindowEvent({ reason: 'run' }))
    await settleHostQueries()
    const completed = makeRun({ status: 'completed' })
    api.automations.listRuns.mockResolvedValue([completed])
    await act(async () => emitAutomationsChangedWindowEvent({ reason: 'run' }))
    await settleHostQueries()

    await act(async () => finishOldRead([makeRun({ status: 'dispatched' })]))
    await rerender()

    expect(mocks.detailPane?.selectedRuns).toEqual([completed])
  })
})
