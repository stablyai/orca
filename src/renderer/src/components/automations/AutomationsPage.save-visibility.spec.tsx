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
import { listedRows } from './automations-page-listed-items'
import { AUTOMATION_ORPHAN_ISSUES } from '../../../../shared/automation-list-scope'
import { makeAutomation, makeStoreState, REPO_ID, WORKSPACE_ID } from './automations-page-fixtures'

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

async function createSweep(beforeSave?: () => Promise<void>): Promise<void> {
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
  await beforeSave?.()
  await act(async () => {
    await mocks.editorDialog?.onSave()
  })
  await settleHostQueries()
}

describe('AutomationsPage save visibility', () => {
  installAutomationsPageHarness()

  it('keeps the editor and explains an unavailable target without writing', async () => {
    desktopStoreHolds([])
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    mocks.state.projectHostSetups = mocks.state.projectHostSetups.map((setup) => ({
      ...setup,
      setupState: 'error'
    }))
    await renderPage()
    await settleHostQueries()

    await createSweep(async () => {
      const control = mocks.editorDialog?.createDestination
      const self = control?.entries.find((entry) => entry.stableRef.selector.kind === 'self')
      expect(self).toBeDefined()
      await act(async () => control?.onSelect(self!.stableKey))
    })

    expect(api.automations.create).not.toHaveBeenCalled()
    expect(api.automations.update).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice).toBeNull()
    expect(mocks.toastError.mock.calls).toEqual([['Choose an available workspace before saving.']])
    expect(mocks.editorDialog?.open).toBe(true)
    expect(mocks.editorDialog?.draft).toMatchObject({ name: 'Sweep', prompt: 'Do the sweep' })
  })

  it.each([true, false])(
    'saves an explicit same-project host selection (orphan=%s)',
    async (orphan) => {
      const saved = makeAutomation({
        enabled: false,
        runContext: null,
        timezone: 'Pacific/Chatham',
        rrule: '*/7 * * * *',
        dtstart: 1700000000000,
        setupDecision: 'skip',
        baseBranch: 'saved/base',
        extraAgentArgs: '--model saved',
        ...(orphan
          ? {}
          : {
              executionTargetType: 'ssh',
              executionTargetId: 'builder',
              executionTargetGeneration: 7
            })
      })
      const selector = orphan
        ? { kind: 'orphan' as const, issue: AUTOMATION_ORPHAN_ISSUES.hostReselection }
        : { kind: 'ssh' as const, targetId: 'builder', targetGeneration: 7 }
      const expectedOwner = { selector: orphan ? { kind: 'orphan' } : selector }
      const destination = { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } }
      const repo = {
        ...makeStoreState().repoMap.get(REPO_ID)!,
        executionHostId: 'ssh:builder' as const,
        connectionId: undefined
      }
      mocks.state.repos = [repo]
      mocks.repoMap = new Map([[repo.id, repo]])
      mocks.state.projectHostSetups = [
        {
          id: 'setup-1',
          projectId: 'project-1',
          hostId: 'ssh:builder',
          repoId: REPO_ID,
          path: repo.path,
          displayName: 'orca',
          setupState: 'ready',
          setupMethod: 'legacy-repo',
          createdAt: 1,
          updatedAt: 1
        }
      ]
      mocks.state.sshTargetLabels = new Map([['builder', 'Builder']])
      mocks.state.sshTargetGenerations = new Map([['builder', 7]])
      mocks.state.sshConnectionStates = new Map([['builder', { status: 'connected' }]])
      api.automations.list.mockResolvedValue([saved])
      api.automations.listScoped.mockImplementation(async ({ selector: scope }) => ({
        automations: scope.kind === selector.kind ? [saved] : [],
        items: scope.kind === selector.kind ? [{ automationId: saved.id, selector }] : [],
        orphanCount: 1
      }))
      api.automations.update.mockResolvedValue(saved)
      const { container } = await renderPage()
      await settleHostQueries()
      const row = listedRows().find((candidate) => candidate.automation.id === saved.id)
      expect(row).toBeDefined()
      if (!row) {
        throw new Error('Missing older automation')
      }
      expect(mocks.listPanel?.isActionEnabled(row, 'edit')).toBe(true)
      await act(async () => {
        await mocks.listPanel?.openEditDialog(row)
      })
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...(current as Record<string, unknown>),
          name: 'Renamed'
        }))
      })
      expect(mocks.editorDialog?.canSave).toBe(true)
      const reread = api.automations.listScoped.getMockImplementation()
      api.automations.listScoped.mockRejectedValue(new Error('Host temporarily unavailable'))
      const readsBeforeFailure = api.automations.listScoped.mock.calls.length
      const writesBeforeFailure = api.automations.update.mock.calls.length
      const expectedRead = {
        selector: orphan
          ? { kind: 'orphan' }
          : { kind: 'ssh', targetId: 'builder', expectedTargetGeneration: 7 }
      }
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="editor-save"]')!.click()
      })
      await settleHostQueries()
      expect(api.automations.listScoped.mock.calls.slice(readsBeforeFailure)).toContainEqual([
        expectedRead
      ])
      expect(api.automations.update).toHaveBeenCalledTimes(writesBeforeFailure)
      expect(mocks.editorDialog?.open).toBe(true)
      expect(mocks.editorDialog?.notice).toMatchObject({
        message: 'Host temporarily unavailable',
        recovery: 'retry'
      })
      api.automations.listScoped.mockImplementation(reread!)
      const readsBeforeRetry = api.automations.listScoped.mock.calls.length
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="editor-save"]')!.click()
      })
      await settleHostQueries()
      expect(api.automations.listScoped.mock.calls.slice(readsBeforeRetry)).toContainEqual([
        expectedRead
      ])
      expect(api.automations.update).toHaveBeenCalledTimes(writesBeforeFailure + 1)
      expect(api.automations.update).toHaveBeenLastCalledWith({
        id: saved.id,
        expectedOwner,
        updates: { name: 'Renamed' },
        destination: undefined
      })
      await act(async () => {
        await mocks.listPanel?.openEditDialog(row)
      })
      const offered = mocks.editorDialog?.editDestination?.entries.find(
        (entry) => entry.stableRef.selector.kind === 'ssh'
      )
      expect(offered).toBeDefined()
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Host"]')!.click()
      })
      await act(async () => {
        document
          .querySelector<HTMLElement>(`[data-host-stable-key="${offered!.stableKey}"]`)!
          .closest<HTMLElement>('[role="option"]')!
          .click()
      })
      expect(mocks.editorDialog?.canSave).toBe(true)
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="editor-save"]')!.click()
      })
      await settleHostQueries()
      expect(mocks.toastError.mock.calls).toEqual([])
      expect(mocks.editorDialog?.notice).toBeNull()
      expect(api.automations.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: saved.id,
          expectedOwner,
          destination
        })
      )
      const lastRequest = api.automations.update.mock.calls.at(-1)?.[0]
      expect(lastRequest?.updates).toMatchObject({
        repo: `id:${REPO_ID}`,
        runContext: { hostId: 'ssh:builder' }
      })
      expect(lastRequest?.updates).not.toHaveProperty('baseBranch')
      expect(lastRequest?.updates).toHaveProperty('workspace', undefined)
      expect(lastRequest?.updates).not.toHaveProperty('extraAgentArgs')
      expect(lastRequest?.updates).not.toHaveProperty('setupDecision')
      expect(lastRequest?.updates).not.toHaveProperty('enabled')
      expect(lastRequest?.updates).not.toHaveProperty('timezone')
      expect(lastRequest?.updates).not.toHaveProperty('rrule')
      expect(lastRequest?.updates).not.toHaveProperty('dtstart')
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

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
