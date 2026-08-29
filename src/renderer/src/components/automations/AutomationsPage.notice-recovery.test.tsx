// @vitest-environment happy-dom

/**
 * What a refused action's recovery button actually does.
 *
 * Both notices used to swallow every verb but Retry, so Update server and
 * Reconnect rendered as buttons that performed nothing. These pin the routing:
 * the verb runs against the host the refusal came from — the row's own owner, or
 * the destination the create dialog captured — not the list's current filter.
 */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  addRuntimeProject,
  api,
  installAutomationsPageHarness,
  listedRow,
  mocks,
  renderPage,
  runtimeHost,
  RUNTIME_REPO_ID,
  RUNTIME_SELF_FILTER,
  RUNTIME_WORKSPACE_ID,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation } from './automations-page-fixtures'

installAutomationsPageHarness()

const FENCING_REQUIRED = 'The host changed: automation_owner_fencing_required'

/** Fails one runtime RPC the way an under-versioned server does, leaving the rest answering. */
function runtimeRpcRefuses(method: string): void {
  const previous = mocks.callRuntimeRpc.getMockImplementation()
  mocks.callRuntimeRpc.mockImplementation(
    async (target: unknown, called: string, params: unknown, options: unknown) => {
      if (called === method) {
        throw new Error(FENCING_REQUIRED)
      }
      return await previous?.(target, called, params, options)
    }
  )
}

function watchSettings(): { open: ReturnType<typeof vi.fn>; target: ReturnType<typeof vi.fn> } {
  const open = vi.fn()
  const target = vi.fn()
  mocks.state.openSettingsPage = open
  mocks.state.openSettingsTarget = target
  return { open, target }
}

describe('AutomationsPage notice recovery', () => {
  it('sends the create dialog Update server to where that destination host is versioned', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeRpcRefuses('automation.create')
    // The runtime's own project: a desktop repo id is refused before any RPC.
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    const settings = watchSettings()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
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
      mocks.editorDialog?.onSave()
    })

    expect(mocks.editorDialog?.notice?.recovery).toBe('update-server')
    await act(async () => {
      mocks.editorDialog?.onNoticeRecover?.('update-server')
    })

    expect(settings.open).toHaveBeenCalled()
    expect(settings.target).toHaveBeenCalledWith({ pane: 'servers', repoId: null })
  })

  it('sends a row Update server to the row own host, not to the unfiltered list', async () => {
    const runtimeAutomation = makeAutomation({ id: 'a-runtime', name: 'On the box' })
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([runtimeAutomation], [])
    runtimeRpcRefuses('automation.update')
    const settings = watchSettings()

    const { container } = await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.toggleAutomation(listedRow(runtimeAutomation.id))
    })

    const notice = container.querySelector('[data-testid="automation-owner-conflict"]')
    const recover = [...(notice?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Update server'
    )
    expect(recover).toBeDefined()
    await act(async () => {
      recover?.click()
    })

    // All hosts selects no host, so only the row's captured owner names one.
    expect(settings.open).toHaveBeenCalled()
    expect(settings.target).toHaveBeenCalledWith({ pane: 'servers', repoId: null })
  })
})
