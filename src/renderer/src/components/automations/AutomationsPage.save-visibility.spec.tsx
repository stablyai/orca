// @vitest-environment happy-dom

/** After save, refetch the visible per-host cache even if automationsChanged never arrives; legacy state writes are offscreen once a host answers. */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { AUTOMATIONS_CHANGED_EVENT } from '@/lib/automations-changed-window-event'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  rows,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, REPO_ID, WORKSPACE_ID } from './automations-page-fixtures'

const DESKTOP_SELF_FILTER = {
  kind: 'host' as const,
  host: { authority: { kind: 'desktop' as const }, selector: { kind: 'self' as const } }
}

const CREATED = makeAutomation({ id: 'a-new', name: 'Sweep' })

/** The desktop store now holds the created row; every later read must say so. */
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

describe('AutomationsPage save visibility', () => {
  installAutomationsPageHarness()

  it('lists a newly created automation on the host it was saved to', async () => {
    desktopStoreHolds([])
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    api.automations.create.mockResolvedValue(CREATED)

    const { container } = await renderPage()
    await settleHostQueries()
    expect(rows(container, 'automation-row')).toEqual([])

    desktopStoreHolds([CREATED])
    await createSweep()

    expect(api.automations.create).toHaveBeenCalledTimes(1)
    expect(rows(container, 'automation-row')).toEqual(['Sweep'])
  })

  it('lists it when the authority publishes its scoped change event', async () => {
    desktopStoreHolds([])
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER

    const { container } = await renderPage()
    await settleHostQueries()

    expect(rows(container, 'automation-row')).toEqual([])
    desktopStoreHolds([CREATED])
    // What `automations:create` publishes for a Self record, verbatim.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AUTOMATIONS_CHANGED_EVENT, {
          detail: { reason: 'definition', selector: { kind: 'self' } }
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(rows(container, 'automation-row')).toEqual(['Sweep'])
    expect(api.automations.create).not.toHaveBeenCalled()
  })

  it('lists it after the page is reopened', async () => {
    desktopStoreHolds([])
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    api.automations.create.mockResolvedValue(CREATED)

    await renderPage()
    await settleHostQueries()
    desktopStoreHolds([CREATED])
    await createSweep()

    const reopened = await renderPage()
    await settleHostQueries()

    expect(rows(reopened.container, 'automation-row')).toEqual(['Sweep'])
  })
})
