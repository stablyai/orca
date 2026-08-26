// @vitest-environment happy-dom

/**
 * Where a new automation lands.
 *
 * Every case here is one the page previously answered by inferring a host from
 * the draft's run context: the storage authority came from whichever machine the
 * workspace happened to execute on, which is exactly what required invariant 1
 * forbids. These pin the stated-destination contract instead — the destination
 * is chosen, shown, re-checked at submit, and refused when it no longer holds.
 */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import { unscopedAutomationListRows, type AutomationListRow } from './automation-list-row-identity'
import {
  addRuntimeProject,
  api,
  installAutomationsPageHarness,
  listedRow,
  mocks,
  renderPage,
  runtimeHost,
  RUNTIME_ID,
  RUNTIME_REPO_ID,
  RUNTIME_SELF_FILTER,
  RUNTIME_WORKSPACE_ID,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, REPO_ID, WORKSPACE_ID } from './automations-page-fixtures'
import type { Repo } from '../../../../shared/repo-types'

installAutomationsPageHarness()

const SSH_TARGET_ID = 'ssh-target-1'
const SSH_REPO_ID = 'repo-ssh'
const SSH_HOST_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'ssh', targetId: SSH_TARGET_ID }
})

const DESKTOP_SELF_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
})
const RUNTIME_SELF_KEY = hostStableKey({
  authority: { kind: 'runtime', environmentId: RUNTIME_ID },
  selector: { kind: 'self' }
})

/** A desktop-registered SSH host, with the generation that makes it fenceable. */
function addSshHost(): void {
  mocks.state.sshTargetLabels = new Map([[SSH_TARGET_ID, 'openclaw']])
  mocks.state.sshTargetGenerations = new Map([[SSH_TARGET_ID, 1]])
  mocks.state.sshConnectionStates = new Map([[SSH_TARGET_ID, { status: 'connected' }]])
}

/** A project checked out on that SSH host rather than locally. */
function addSshProject(): void {
  const repo = {
    id: SSH_REPO_ID,
    displayName: 'orca',
    path: '/repos/orca',
    badgeColor: '#222222',
    addedAt: 1,
    worktreeBaseRef: 'main',
    connectionId: SSH_TARGET_ID
  } as Repo
  mocks.state.repos = [...(mocks.state.repos as Repo[]), repo]
  mocks.repoMap.set(SSH_REPO_ID, repo)
}

/** The runtime answers a create; without this the RPC double returns an empty result. */
function runtimeCreateReturns(automation: Automation): void {
  const previous = mocks.callRuntimeRpc.getMockImplementation()
  mocks.callRuntimeRpc.mockImplementation(
    async (target: unknown, method: string, params: unknown, options: unknown) => {
      if (method === 'automation.create') {
        return { automation }
      }
      return await previous?.(target, method, params, options)
    }
  )
}

async function openCreateDialogFor(projectId: string, workspaceId: string): Promise<void> {
  await act(async () => {
    mocks.listPanel?.openCreateDialog()
  })
  await act(async () => {
    mocks.editorDialog?.onDraftChange((current) => ({
      ...(current as Record<string, unknown>),
      name: 'Sweep',
      prompt: 'Do the sweep',
      projectId,
      workspaceMode: 'existing',
      workspaceId
    }))
  })
}

async function save(): Promise<void> {
  await act(async () => {
    mocks.editorDialog?.onSave()
  })
}

function runtimeCreateCalls(): unknown[][] {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'automation.create')
}

describe('AutomationsPage create destination', () => {
  it('creates on the selected runtime rather than under the desktop authority', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
    await save()

    // The desktop is the client's own authority, never the selected host — and
    // the id sent is the runtime's own, never a desktop repo id it cannot resolve.
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(runtimeCreateCalls()).toHaveLength(1)
    expect(runtimeCreateCalls()[0]?.[2]).toMatchObject({
      repo: `id:${RUNTIME_REPO_ID}`,
      workspace: `id:${RUNTIME_WORKSPACE_ID}`,
      destination: { selector: { kind: 'self' } }
    })
  })

  it('refuses a desktop project for a runtime destination instead of sending its id', async () => {
    // The repo_not_found bug: the desktop repo id can never resolve on the
    // runtime, so the submit is refused here rather than by the remote host.
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    await save()

    expect(api.automations.create).not.toHaveBeenCalled()
    expect(runtimeCreateCalls()).toHaveLength(0)
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })

  it('refuses a runtime-owned project under the desktop destination', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addRuntimeProject()

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
    await save()

    // A repo with no connection ID is not evidence of local: this one is the
    // runtime's, and the desktop's Self host cannot hold an automation for it.
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })

  it('requires an explicit host choice when All hosts spans more than one host', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    addRuntimeProject()

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    await save()

    expect(api.automations.create).not.toHaveBeenCalled()
    expect(runtimeCreateCalls()).toHaveLength(0)
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.createDestination?.entries.map((entry) => entry.stableKey)).toEqual(
      expect.arrayContaining([DESKTOP_SELF_KEY, RUNTIME_SELF_KEY])
    )

    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    expect(mocks.editorDialog?.createDestination?.resolution.status).toBe('ready')
    // The stated host stranded the desktop project; the draft moves to its own.
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        projectId: RUNTIME_REPO_ID,
        workspaceId: RUNTIME_WORKSPACE_ID
      }))
    })
    await save()

    expect(runtimeCreateCalls()).toHaveLength(1)
    expect(api.automations.create).not.toHaveBeenCalled()
  })

  it('offers only the projects the chosen host actually has', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()
    addSshProject()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })

    // The local project shares this one's name, so offering both leaves the user
    // no way to tell which is the one on that host.
    expect(mocks.editorDialog?.repos?.map((repo) => repo.id)).toEqual([SSH_REPO_ID])
  })

  it('moves a stranded project to one the newly chosen host has', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()
    addSshProject()

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    expect(mocks.editorDialog?.draft?.projectId).toBe(REPO_ID)

    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })

    // Keeping the local project selected only defers the same refusal to submit.
    expect(mocks.editorDialog?.draft?.projectId).toBe(SSH_REPO_ID)
  })

  it('offers nothing rather than a stranded project when the host has no projects', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })

    expect(mocks.editorDialog?.repos).toEqual([])
    // Nothing is left selected to submit against a host that cannot hold it.
    expect(mocks.editorDialog?.draft?.projectId).toBe('')
  })

  it('states the chosen host on the form before submit', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(RUNTIME_SELF_KEY)
    })

    const resolution = mocks.editorDialog?.createDestination?.resolution
    // The owner shown is the storage authority, not the workspace's run host.
    expect(resolution?.status === 'ready' && resolution.entry.stableKey).toBe(RUNTIME_SELF_KEY)
    expect(resolution?.status === 'ready' && resolution.authority).toEqual({
      kind: 'runtime',
      environmentId: RUNTIME_ID,
      pairingRevision: 4
    })
  })

  it('fails closed when the destination host changes incarnation while the form is open', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER

    const { rerender } = await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)

    // The host re-paired while the form was open: same stable key, new owner.
    mocks.state.runtimeEnvironments = [
      { id: RUNTIME_ID, name: 'GPU box', createdAt: 1, pairingRevision: 9 }
    ]
    await rerender()
    await save()

    expect(runtimeCreateCalls()).toHaveLength(0)
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })
})

describe('AutomationsPage edit fencing', () => {
  async function editAndSave(row: AutomationListRow): Promise<void> {
    await act(async () => {
      void mocks.listPanel?.openEditDialog(row)
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        name: 'Renamed'
      }))
    })
    await save()
  }

  function updatePreconditions(): unknown[] {
    return api.automations.update.mock.calls.map(
      ([payload]) => (payload as { expectedOwner?: unknown }).expectedOwner
    )
  }

  it('fences the save even when the record cannot be re-read', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])

    await renderPage()
    await settleHostQueries()
    // The row is gone from its host by the time the form is saved.
    scopedList([])
    await editAndSave(listedRow(automation.id))

    expect(api.automations.update).toHaveBeenCalled()
    expect(updatePreconditions()).not.toContain(undefined)
  })

  it('refuses the save when nothing names the record’s host', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    // No host answered, so no owner was ever captured, and the record is gone
    // from the one list the client can still address.
    api.automations.listScoped.mockRejectedValue(new Error('offline'))
    api.automations.list.mockResolvedValue([])

    await renderPage()
    await settleHostQueries()
    // No host answered, so the page never listed a row for it; the pre-catalog
    // projection is the only key the user could have clicked.
    await editAndSave(unscopedAutomationListRows([automation])[0]!)

    expect(api.automations.update).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
  })
})

describe('AutomationsPage edit dialog projects', () => {
  it('offers the edited row’s own host projects, not the create destination’s', async () => {
    const automation = makeAutomation({
      id: 'a-runtime',
      projectId: RUNTIME_REPO_ID,
      workspaceId: RUNTIME_WORKSPACE_ID
    })
    // The ambient list is the desktop's and never held this record, so an
    // id lookup there answers with nothing and the row's owner is all there is.
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([automation], [])
    addRuntimeProject()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })

    expect(mocks.editorDialog?.isEditing).toBe(true)
    expect(mocks.editorDialog?.repos?.map((repo) => repo.id)).toEqual([RUNTIME_REPO_ID])
  })
})

describe('AutomationsPage create admission', () => {
  it('keeps the create button available while every offered host is ineligible', async () => {
    // No host has answered, so nothing resolves ready — but the dialog is where
    // an ineligible host's repair is stated, so the button must still open it.
    api.automations.listScoped.mockRejectedValue(new Error('offline'))
    api.automations.list.mockResolvedValue([])

    await renderPage()
    await settleHostQueries()

    expect(mocks.listPanel?.canCreateAutomation).toBe(true)
  })

  it('refuses a mismatched create destination before the hooks trust prompt', async () => {
    // A runtime-owned project under the sole desktop destination: refused, and
    // refused before the user is asked to trust that project's setup hooks.
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addRuntimeProject()
    // A setup hook whose default policy is run-by-default, so the old save
    // order would have raised the trust prompt before refusing the create.
    const { checkRuntimeHooks } = await import('@/runtime/runtime-hooks-client')
    vi.mocked(checkRuntimeHooks).mockResolvedValue({
      status: 'ok',
      hooks: { scripts: { setup: 'pnpm install' } }
    } as never)

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
        workspaceMode: 'new_per_run',
        workspaceId: ''
      }))
    })
    await save()

    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    const { ensureHooksConfirmed } = await import('@/lib/ensure-hooks-confirmed')
    expect(vi.mocked(ensureHooksConfirmed)).not.toHaveBeenCalled()
    expect(api.automations.create).not.toHaveBeenCalled()
  })
})
