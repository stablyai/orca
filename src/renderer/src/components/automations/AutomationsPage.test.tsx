// @vitest-environment happy-dom

/**
 * Characterization tests for the automations page.
 *
 * This file pins the page's *current* observable orchestration — which requests
 * it makes, in what shape, and what it hands to its children — so the Step 6/7/9
 * rewrites have a safety net. Several assertions describe behavior those steps
 * will deliberately replace; each is marked with the step that owns the change,
 * so an edit there reads as intended rather than as a regression.
 *
 * The mount rig, child stand-ins, and preload API double live in
 * `automations-page-test-harness`; the refresh triggers and which row's history
 * they leave on screen live in `AutomationsPage.refresh-selection.test.tsx`.
 */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_ORPHAN_ISSUES,
  type AutomationListParams
} from '../../../../shared/automation-list-scope'
import {
  api,
  DESKTOP_SELF_OWNER,
  installAutomationsPageHarness,
  listedRow,
  mocks,
  renderPage,
  rows,
  scopedList,
  SELF_PRECONDITION
} from './automations-page-test-harness'
import {
  makeAutomation,
  makeExternalManager,
  REPO_ID,
  WORKSPACE_ID
} from './automations-page-fixtures'

installAutomationsPageHarness()

describe('AutomationsPage list rendering', () => {
  it('renders the rows the host-scoped read returned, not the unscoped list', async () => {
    api.automations.list.mockResolvedValue([makeAutomation({ id: 'a-9', name: 'Unscoped' })])
    scopedList([
      makeAutomation({ id: 'a-1', name: 'Nightly' }),
      makeAutomation({ id: 'a-2', name: 'Weekly' })
    ])

    const { container } = await renderPage()

    expect(api.automations.listScoped).toHaveBeenCalledWith({ selector: { kind: 'self' } })
    expect(rows(container, 'automation-row')).toEqual(['Nightly', 'Weekly'])
  })

  it('falls back to the unscoped list until a host has answered', async () => {
    api.automations.list.mockResolvedValue([makeAutomation({ id: 'a-9', name: 'Unscoped' })])
    api.automations.listScoped.mockRejectedValue(new Error('offline'))

    const { container } = await renderPage()

    // Why: a host that never answered is not an empty host, and the rows the
    // page already had are better than none. Step 9 removes this arm.
    expect(rows(container, 'automation-row')).toEqual(['Unscoped'])
  })

  it('renders the empty state when the host has no automations', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])

    const { container } = await renderPage()

    expect(container.querySelector('[data-testid="empty-state"]')).not.toBeNull()
    expect(rows(container, 'automation-row')).toEqual([])
  })

  it('handles a failed list instead of leaking an unhandled rejection', async () => {
    // Before Step 7b this was pinned as *unhandled*: refresh() was try/finally
    // with no catch and was called as `void refresh()`.
    const unhandled: unknown[] = []
    const capture = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', capture)
    api.automations.list.mockRejectedValue(new Error('offline'))
    scopedList([makeAutomation({ id: 'a-1', name: 'Nightly' })])

    const { container } = await renderPage()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    process.off('unhandledRejection', capture)

    expect(unhandled).toEqual([])
    expect(container.querySelector('[data-testid="list-panel"]')).not.toBeNull()
    // The host answered for itself, so its rows survive the unscoped failure.
    expect(rows(container, 'automation-row')).toEqual(['Nightly'])
  })

  it('reports a host that could not be loaded, with a way to retry it', async () => {
    api.automations.list.mockRejectedValue(new Error('offline'))
    api.automations.listScoped.mockRejectedValue(new Error('offline'))

    await renderPage()

    expect(mocks.listPanel?.hostCatalog.loadCounts).toEqual({
      failedHostCount: 1,
      totalHostCount: 1
    })
    const entry = mocks.listPanel?.hostCatalog.entries[0]
    api.automations.listScoped.mockClear()
    await act(async () => {
      mocks.listPanel?.hostCatalog.recover('retry', entry)
    })

    // Retry re-queries that host rather than reloading the page.
    expect(api.automations.listScoped).toHaveBeenCalledWith({ selector: { kind: 'self' } })
  })

  it('lists external managers per captured owner rather than probing the machine', async () => {
    api.automations.list.mockResolvedValue([])
    api.automations.listExternalManagerForOwner.mockImplementation(
      async ({ provider }: { provider: string }) =>
        provider === 'hermes'
          ? { manager: makeExternalManager(), error: null, updatedAt: 1 }
          : { manager: null, error: null, updatedAt: 1 }
    )

    const { container } = await renderPage()

    expect(api.automations.listExternalManagerForOwner).toHaveBeenCalledWith({
      owner: DESKTOP_SELF_OWNER,
      provider: 'hermes'
    })
    expect(rows(container, 'external-row')).toEqual(['Hermes job'])
  })

  it('keeps the edited external automation selected after its save', async () => {
    api.automations.list.mockResolvedValue([])
    api.automations.listExternalManagerForOwner.mockImplementation(
      async ({ provider }: { provider: string }) =>
        provider === 'hermes'
          ? { manager: makeExternalManager(), error: null, updatedAt: 1 }
          : { manager: null, error: null, updatedAt: 1 }
    )
    api.automations.updateExternalForOwner.mockResolvedValue(undefined)

    await renderPage()
    const entry = mocks.listPanel?.filteredExternalAutomationEntries[0]
    if (!entry) {
      throw new Error('no external entry to edit')
    }

    await act(async () => {
      mocks.listPanel?.openEditExternalDialog(entry.manager, entry.job, entry.scope)
    })
    await act(async () => {
      mocks.editorDialog?.onSave()
    })

    // The row key and the post-save selection are built by two different call
    // sites; if they ever stop agreeing, selection silently falls through to the
    // first row and the user's edit appears to open someone else's automation.
    expect(api.automations.updateExternalForOwner).toHaveBeenCalled()
    expect(mocks.listPanel?.selectedExternal?.key).toBe(entry.key)
  })

  it('routes each authority’s action to its own host when both report hermes:local', async () => {
    api.automations.list.mockResolvedValue([])
    api.automations.listExternalManagerForOwner.mockImplementation(
      async ({ provider }: { provider: string }) =>
        provider === 'hermes'
          ? { manager: makeExternalManager({ id: 'hermes:local' }), error: null, updatedAt: 1 }
          : { manager: null, error: null, updatedAt: 1 }
    )
    api.automations.runExternalActionForOwner.mockResolvedValue(undefined)

    await renderPage()
    const entry = mocks.listPanel?.filteredExternalAutomationEntries[0]
    if (!entry) {
      throw new Error('no external entry to act on')
    }
    // The second authority a multi-host build will list: same provider, same
    // `hermes:local` manager ID, different machine. The desktop fixture is the
    // only host that actually answers, so a scope recovered from the manager ID
    // would resolve BOTH rows to it and pause the wrong host's cron job.
    const runtimeScope = {
      ...entry.scope,
      owner: {
        authority: { kind: 'runtime' as const, environmentId: 'env-7', pairingRevision: 1 },
        selector: { kind: 'self' as const }
      }
    }

    await act(async () => {
      mocks.listPanel?.requestExternalAction(entry.manager, entry.job, 'pause', entry.scope)
    })
    await act(async () => {
      mocks.listPanel?.requestExternalAction(entry.manager, entry.job, 'pause', runtimeScope)
    })

    const owners = api.automations.runExternalActionForOwner.mock.calls.map(
      (call) => (call[0] as { owner: unknown }).owner
    )
    expect(owners).toEqual([entry.scope.owner, runtimeScope.owner])
  })

  it('reads runs from the host the table names, not the one holding the manager ID', async () => {
    api.automations.list.mockResolvedValue([])
    api.automations.listExternalManagerForOwner.mockImplementation(
      async ({ provider }: { provider: string }) =>
        provider === 'hermes'
          ? { manager: makeExternalManager({ id: 'hermes:local' }), error: null, updatedAt: 1 }
          : { manager: null, error: null, updatedAt: 1 }
    )
    api.automations.listExternalRunsForOwner.mockResolvedValue({ runs: [], total: 0 })

    const { container } = await renderPage()
    const entry = mocks.listPanel?.filteredExternalAutomationEntries[0]
    if (!entry) {
      throw new Error('no external entry to read runs for')
    }
    const runtimeScope = {
      ...entry.scope,
      owner: {
        authority: { kind: 'runtime' as const, environmentId: 'env-7', pairingRevision: 1 },
        selector: { kind: 'self' as const }
      }
    }

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="external-row"]')?.click()
    })

    await act(async () => {
      await mocks.detailPane?.fetchExternalAutomationRuns({
        scope: runtimeScope,
        manager: entry.manager,
        job: entry.job,
        page: 0,
        pageSize: 8
      })
    })

    // Run output is read, not written, but a wrong host still shows one machine's
    // logs under another's automation — and the desktop is the only host listed,
    // so an ID-keyed lookup would answer with it every time.
    expect(api.automations.listExternalRunsForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ owner: runtimeScope.owner, jobId: entry.job.id })
    )
  })
})

describe('AutomationsPage host filter', () => {
  it('hands the catalog and the resolved filter to the picker', async () => {
    await renderPage()

    expect(mocks.listPanel?.hostCatalog.resolution.effective).toEqual({ kind: 'all' })
    expect(mocks.listPanel?.hostCatalog.entries.map((entry) => entry.kind)).toEqual(['self'])
  })

  it('groups rows by authority under All hosts', async () => {
    scopedList([makeAutomation({ id: 'a-1', name: 'Nightly' })])

    await renderPage()

    const groups = mocks.listPanel?.hostCatalog.rows.groups ?? []
    expect(groups.map((group) => group.authorityKey)).toEqual(['authority:desktop'])
    expect(groups[0]?.hosts[0]?.rows.map((row) => row.automation.name)).toEqual(['Nightly'])
  })

  it('feeds the search layer the counts and host labels it already computed', async () => {
    scopedList([makeAutomation({ id: 'a-1', name: 'Nightly' })])

    await renderPage()

    expect(mocks.listPanel?.searchCounts).toEqual({
      hostRowCount: 1,
      visibleRowCount: 1,
      searchActive: false
    })
    expect(mocks.listPanel?.hostCatalog.rows.rows[0]?.hostLabel).toBeTruthy()
  })

  it('persists a host selection through the store rather than page state', async () => {
    await renderPage()
    await act(async () => {
      mocks.listPanel?.onSelectHost({ kind: 'all' })
    })

    expect(mocks.setAutomationHostFilter).toHaveBeenCalledWith({ kind: 'all' })
  })
})

describe('AutomationsPage run navigation', () => {
  it('does not leave a run navigation pending when the history read fails', async () => {
    api.automations.list.mockResolvedValue([
      makeAutomation({ id: 'a-1' }),
      makeAutomation({ id: 'a-2' })
    ])
    scopedList([makeAutomation({ id: 'a-1' }), makeAutomation({ id: 'a-2' })])
    api.automations.listRuns.mockImplementation(
      async (args: { automationId: string; expectedOwner?: unknown }) => {
        if (args.automationId === 'a-2' && args.expectedOwner) {
          throw new Error('web-01 is not connected')
        }
        return []
      }
    )
    mocks.state.setPendingAutomationRunNavigation = mocks.setPendingRunNavigation
    const { rerender } = await renderPage()

    mocks.state.selectedAutomationId = 'a-2'
    mocks.state.pendingAutomationRunNavigation = {
      automationId: 'a-2',
      runId: 'run-9',
      hostId: null
    }
    await rerender()
    await rerender()

    // The navigation is persisted UI state, so stuck here means stuck across reopens.
    expect(mocks.setPendingRunNavigation).toHaveBeenCalledWith(null)
    expect(mocks.detailPane?.selectedRunsNotice?.message).toContain('web-01 is not connected')
  })
})

describe('AutomationsPage mutations', () => {
  it('routes Run Now to the desktop authority', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([automation])

    await renderPage()
    await act(async () => {
      mocks.listPanel?.runNow(listedRow(automation.id))
    })

    // Step 6: the request names the owner captured when the row was listed.
    expect(api.automations.runNow).toHaveBeenCalledWith({
      id: 'a-1',
      expectedOwner: SELF_PRECONDITION
    })
  })

  it('routes enable/disable to an update on the owning authority', async () => {
    const automation = makeAutomation({ id: 'a-1', enabled: true })
    api.automations.list.mockResolvedValue([automation])

    await renderPage()
    await act(async () => {
      mocks.listPanel?.toggleAutomation(listedRow(automation.id))
    })

    expect(api.automations.update).toHaveBeenCalledWith({
      id: 'a-1',
      updates: { enabled: false },
      expectedOwner: SELF_PRECONDITION,
      destination: undefined
    })
  })

  it('re-reads the record before opening the edit dialog', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([automation])

    await renderPage()
    api.automations.list.mockClear()
    await act(async () => {
      mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })

    // Step 6: hydration re-reads the row's own scope; the ambient list is untouched.
    expect(api.automations.list).not.toHaveBeenCalled()
    expect(api.automations.listScoped).toHaveBeenCalledWith({ selector: { kind: 'self' } })
    expect(mocks.editorDialog?.open).toBe(true)
    expect(mocks.editorDialog?.isEditing).toBe(true)
  })

  it('opens the create dialog without an editing target', async () => {
    await renderPage()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })

    expect(mocks.editorDialog?.open).toBe(true)
    expect(mocks.editorDialog?.isEditing).toBe(false)
  })

  it('deletes through the owning authority once the dialog confirms', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([automation])

    await renderPage()
    await act(async () => {
      mocks.listPanel?.requestDeleteAutomation(listedRow(automation.id))
    })
    expect(mocks.deleteDialog?.deleteTarget?.id).toBe('a-1')

    await act(async () => {
      mocks.deleteDialog?.onConfirm()
    })

    expect(api.automations.delete).toHaveBeenCalledWith({
      id: 'a-1',
      expectedOwner: SELF_PRECONDITION
    })
  })

  it('creates at an explicitly stated destination rather than an inferred host', async () => {
    api.automations.list.mockResolvedValue([])

    await renderPage()
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
      mocks.editorDialog?.onSave()
    })

    expect(api.automations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Sweep',
        destination: { selector: { kind: 'self' } }
      })
    )
  })

  it('refreshes after a mutation so the list reflects the write', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([automation])

    await renderPage()
    api.automations.list.mockClear()
    await act(async () => {
      mocks.listPanel?.toggleAutomation(listedRow(automation.id))
    })

    expect(api.automations.list).toHaveBeenCalled()
  })
})

describe('AutomationsPage owner conflicts', () => {
  function conflict(code: string): Error {
    return new Error(`The host changed: ${code}`)
  }

  function notice(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-testid="automation-owner-conflict"]')
  }

  it('surfaces a changed owner as a recoverable notice instead of a thrown error', async () => {
    const automation = makeAutomation({ id: 'a-1', enabled: true })
    api.automations.list.mockResolvedValue([automation])
    api.automations.update.mockRejectedValue(conflict('automation_owner_changed'))

    const { container } = await renderPage()
    await act(async () => {
      mocks.listPanel?.toggleAutomation(listedRow(automation.id))
    })

    expect(notice(container)?.textContent).toContain("This automation's host changed")
    expect(notice(container)?.textContent).toContain('Retry')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("offers no recovery action when the automation's SSH host was deregistered", async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([automation])
    api.automations.delete.mockRejectedValue(conflict('automation_target_removed'))

    const { container } = await renderPage()
    await act(async () => {
      mocks.listPanel?.requestDeleteAutomation(listedRow(automation.id))
    })
    await act(async () => {
      mocks.deleteDialog?.onConfirm()
    })

    // Nothing the page can retry or reconnect re-registers a removed host.
    expect(notice(container)?.textContent).toContain('SSH host was removed')
    expect(notice(container)?.textContent).not.toContain('Retry')
  })

  it('refuses a save inside the dialog that hides the page, not behind it', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([automation])
    api.automations.update.mockRejectedValue(conflict('automation_owner_changed'))

    const { container } = await renderPage()
    await act(async () => {
      mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        prompt: 'Edited'
      }))
    })
    await act(async () => {
      mocks.editorDialog?.onSave()
    })

    // The dialog stays open over the page, so a notice posted to the page is a
    // save that did nothing at all as far as the user can tell.
    expect(mocks.editorDialog?.open).toBe(true)
    expect(mocks.editorDialog?.notice?.message).toContain("This automation's host changed")
    expect(notice(container)).toBeNull()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('tells the user to update a server that cannot fence the request', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([automation])
    api.automations.runNow.mockRejectedValue(conflict('automation_owner_fencing_required'))

    const { container } = await renderPage()
    await act(async () => {
      mocks.listPanel?.runNow(listedRow(automation.id))
    })

    expect(notice(container)?.textContent).toContain('Update server')
    expect(mocks.toastMessage).not.toHaveBeenCalled()
  })

  it('refuses to open the editor on a row whose owner moved', async () => {
    const automation = makeAutomation({ id: 'a-1' })

    const { container } = await renderPage()
    // The row was captured by the initial host read; the re-read is what fails.
    api.automations.listScoped.mockRejectedValue(conflict('automation_owner_changed'))
    await act(async () => {
      mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })

    expect(mocks.editorDialog?.open).toBe(false)
    expect(notice(container)).not.toBeNull()
  })

  it('still opens the editor when the re-read merely failed', async () => {
    const automation = makeAutomation({ id: 'a-1' })

    await renderPage()
    api.automations.listScoped.mockRejectedValue(new Error('offline'))
    await act(async () => {
      mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })

    // Why: a transport failure degrades to the copy on screen, as it did before Step 6.
    expect(mocks.editorDialog?.open).toBe(true)
    expect(mocks.editorDialog?.isEditing).toBe(true)
  })

  it('keeps the unfenced call for a row no host read has answered for', async () => {
    // The host never answered, so no row carries an owner and none may be
    // invented; the request goes out unfenced rather than against a guess.
    const automation = makeAutomation({ id: 'a-1', enabled: true })
    api.automations.list.mockResolvedValue([automation])
    api.automations.listScoped.mockRejectedValue(new Error('offline'))

    await renderPage()
    await act(async () => {
      mocks.listPanel?.toggleAutomation(listedRow(automation.id))
    })

    // Why: Step 9 removes this legacy arm once every row carries a captured owner.
    expect(api.automations.update).toHaveBeenCalledWith({
      id: 'a-1',
      updates: { enabled: false }
    })
  })

  // A mixed-host folder workspace is the path that reaches this without a host
  // ever being removed, so the orphan bucket has to hold rows on a healthy machine.
  it('lists an ambiguous-workspace row in the orphan bucket and keeps History on it', async () => {
    const orphaned = makeAutomation({ id: 'a-2', name: 'Ambiguous' })
    api.automations.listScoped.mockImplementation(async (params: AutomationListParams) =>
      params.selector?.kind === 'orphan'
        ? {
            automations: [orphaned],
            items: [
              {
                automationId: 'a-2',
                selector: { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous }
              }
            ],
            orphanCount: 1
          }
        : {
            automations: [makeAutomation()],
            items: [{ automationId: 'a-1', selector: { kind: 'self' } }],
            orphanCount: 1
          }
    )

    const { container, rerender } = await renderPage()
    // The orphan scope is only listed once an authority has reported a count,
    // so the entry appears on the catalog that follows the first answer.
    await rerender()

    expect(api.automations.listScoped).toHaveBeenCalledWith({ selector: { kind: 'orphan' } })
    expect(rows(container, 'automation-row')).toContain('Ambiguous')
    const orphanedRow = listedRow(orphaned.id)
    expect(mocks.listPanel?.isActionEnabled(orphanedRow, 'history')).toBe(true)
    expect(mocks.listPanel?.isActionEnabled(orphanedRow, 'run-now')).toBe(false)
  })

  it('greys out the actions on a row no owner could be captured for', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([automation])
    api.automations.listScoped.mockRejectedValue(new Error('offline'))

    await renderPage()

    // Uncaptured is not blocked: the legacy arm still works, so nothing is greyed.
    expect(mocks.listPanel?.isActionEnabled(listedRow(automation.id), 'delete')).toBe(true)
  })
})

describe('AutomationsPage refresh independence', () => {
  // The external-manager probe is per host and can hang on a dead provider; the
  // automation list must settle without waiting for it.
  it('settles the list even when the external manager probe never answers', async () => {
    api.automations.listExternalManagerForOwner.mockReturnValue(new Promise(() => undefined))

    const { container } = await renderPage()

    expect(rows(container, 'automation-row')).toEqual(['Nightly'])
    expect((mocks.listPanel as { isRefreshing?: boolean } | null)?.isRefreshing).toBe(false)
  })
})
