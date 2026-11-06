// @vitest-environment happy-dom

/** StrictMode disposes the first controller; the revived mount must still refetch on writes/change events rather than retain initial rows forever. */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import { AUTOMATIONS_CHANGED_EVENT } from '@/lib/automations-changed-window-event'
import {
  addRuntimeProject,
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  rows,
  runtimeHost,
  RUNTIME_ID,
  RUNTIME_REPO_ID,
  RUNTIME_WORKSPACE_ID,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, REPO_ID, WORKSPACE_ID } from './automations-page-fixtures'

const CREATED = makeAutomation({ id: 'a-new', name: 'Sweep' })

const RUNTIME_SELF_KEY = hostStableKey({
  authority: { kind: 'runtime', environmentId: RUNTIME_ID },
  selector: { kind: 'self' }
})

function desktopStoreHolds(automations: Automation[]): void {
  api.automations.list.mockResolvedValue(automations)
  scopedList(automations)
}

async function createSweep(): Promise<void> {
  await act(async () => {
    mocks.listPanel?.openCreateDialog()
  })
  await act(async () => {
    mocks.editorDialog?.onDraftChange((current) => ({
      ...(current as Record<string, unknown>),
      name: 'Sweep',
      prompt: 'Do the sweep',
      projectId: REPO_ID,
      workspaceMode: 'existing',
      workspaceId: WORKSPACE_ID
    }))
  })
  await act(async () => {
    await mocks.editorDialog?.onSave()
  })
  await settleHostQueries()
}

describe('AutomationsPage save visibility under StrictMode', () => {
  installAutomationsPageHarness()

  it('lists a newly created automation without a reload', async () => {
    desktopStoreHolds([])
    api.automations.create.mockResolvedValue(CREATED)

    const { container } = await renderPage({ strict: true })
    await settleHostQueries()
    expect(rows(container, 'automation-row')).toEqual([])

    desktopStoreHolds([CREATED])
    await createSweep()

    expect(api.automations.create).toHaveBeenCalledTimes(1)
    expect(rows(container, 'automation-row')).toEqual(['Sweep'])
  })

  it('still refetches when the authority publishes its change event', async () => {
    desktopStoreHolds([])

    const { container } = await renderPage({ strict: true })
    await settleHostQueries()
    expect(rows(container, 'automation-row')).toEqual([])

    // Writes from another window or CLI reach this page only through the event.
    desktopStoreHolds([CREATED])
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AUTOMATIONS_CHANGED_EVENT, {
          detail: { reason: 'definition', selector: { kind: 'self' } }
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(rows(container, 'automation-row')).toEqual(['Sweep'])
  })

  it('lists a create on a runtime-host destination without a reload', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    addRuntimeProject()
    const previous = mocks.callRuntimeRpc.getMockImplementation()
    mocks.callRuntimeRpc.mockImplementation(
      async (target: unknown, method: string, params: unknown, options: unknown) => {
        if (method === 'automation.create') {
          // The runtime store now holds the row; later list reads must say so.
          mocks.state.runtimeAnswers = { automations: [CREATED], runs: [] }
          return { automation: CREATED }
        }
        return await previous?.(target, method, params, options)
      }
    )

    const { container } = await renderPage({ strict: true })
    await settleHostQueries()
    expect(rows(container, 'automation-row')).toEqual([])

    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        name: 'Sweep',
        prompt: 'Do the sweep',
        projectId: RUNTIME_REPO_ID,
        workspaceMode: 'existing',
        workspaceId: RUNTIME_WORKSPACE_ID
      }))
    })
    await act(async () => {
      await mocks.editorDialog?.onSave()
    })
    await settleHostQueries()

    expect(rows(container, 'automation-row')).toEqual(['Sweep'])
  })
})
