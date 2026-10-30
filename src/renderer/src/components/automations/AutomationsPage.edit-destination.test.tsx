// @vitest-environment happy-dom

import {
  addRuntimeProject,
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  runtimeHost,
  RUNTIME_ID,
  RUNTIME_REPO_ID,
  RUNTIME_WORKSPACE_ID,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import {
  CHAT_CAPABILITIES,
  createRpcCalls,
  draftRecord,
  runtimeCreateReturns,
  save
} from './automations-page-actions-test-harness'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AUTOMATION_SURFACE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import { unscopedAutomationListRows, type AutomationListRow } from './automation-list-row-identity'
import {
  addSshHost,
  addSshProject,
  capableChatDestination,
  DESKTOP_SELF_KEY,
  RUNTIME_SELF_KEY,
  SSH_HOST_KEY,
  SSH_REPO_ID,
  SSH_TARGET_ID
} from './automations-page-destination-fixtures'
import { selfScopedList } from './automations-page-runtime-fixtures'
import { listedRow } from './automations-page-listed-items'
import { makeAutomation, REPO_ID } from './automations-page-fixtures'

installAutomationsPageHarness()

/** A runtime project with the same host-local id as the desktop project. */
function addCollidingRuntimeProject(): void {
  const repo: Repo = {
    id: REPO_ID,
    displayName: 'orca on m4-air',
    path: '/repos/orca',
    badgeColor: '#111111',
    addedAt: 1,
    worktreeBaseRef: 'main',
    executionHostId: `runtime:${RUNTIME_ID}`
  }
  mocks.state.repos = [...(mocks.state.repos as Repo[]), repo]
  mocks.state.projectHostSetups = [
    ...mocks.state.projectHostSetups,
    {
      id: 'setup-runtime-collision',
      projectId: 'project-runtime-collision',
      hostId: `runtime:${RUNTIME_ID}`,
      repoId: REPO_ID,
      path: '/repos/orca',
      displayName: 'orca on m4-air',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
  ]
}

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
    mocks.state.settings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: true }
    const { setLocalRuntimeCapabilitiesForTests } =
      await import('@/runtime/local-runtime-capabilities')
    setLocalRuntimeCapabilitiesForTests(null)
    api.automations.list.mockResolvedValue([])
    scopedList([automation])

    await renderPage()
    await settleHostQueries()
    // The row is gone from its host by the time the form is saved.
    scopedList([])
    await editAndSave(listedRow(automation.id))

    expect(api.automations.update).toHaveBeenCalled()
    expect(updatePreconditions()).not.toContain(undefined)
    expect(api.automations.update.mock.calls[0]?.[0]).toMatchObject({
      updates: { name: 'Renamed' }
    })
    expect(api.automations.update.mock.calls[0]?.[0]?.updates).not.toHaveProperty(
      'launchSetupPatch'
    )
  })

  it('keeps saved Chat explicit through the real edit reread and atomically clears arguments', async () => {
    const automation = makeAutomation({ surface: 'chat', extraAgentArgs: '--model opus' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    const { setLocalRuntimeCapabilitiesForTests } =
      await import('@/runtime/local-runtime-capabilities')
    setLocalRuntimeCapabilitiesForTests(CHAT_CAPABILITIES)
    const page = await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...draftRecord(current),
        extraAgentArgs: ''
      }))
    })
    const held = Promise.withResolvers<ReturnType<typeof selfScopedList>>()
    api.automations.listScoped.mockClear().mockReturnValueOnce(held.promise)
    try {
      await save()
      expect(api.automations.listScoped).toHaveBeenCalled()
      expect(api.automations.update).not.toHaveBeenCalled()
      setLocalRuntimeCapabilitiesForTests(null)
      await page.rerender()
      await act(async () => {
        held.resolve(selfScopedList([automation]))
      })
      await settleHostQueries()
      expect(api.automations.update).toHaveBeenCalledOnce()
      expect(api.automations.update.mock.calls[0]?.[0]).toMatchObject({
        id: automation.id,
        expectedOwner: { selector: { kind: 'self' } },
        updates: {
          launchSetupPatch: { surface: 'chat', arguments: { kind: 'legacy-extras', value: '' } }
        }
      })
      expect(api.automations.update.mock.calls[0]?.[0]?.updates).not.toHaveProperty(
        'extraAgentArgs'
      )
      expect(mocks.toastSuccess).toHaveBeenCalledOnce()
    } finally {
      held.resolve(selfScopedList([automation]))
    }
  })

  it('refuses the save when nothing names the record’s host', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    // No host answered, so no owner was captured; the legacy-addressable record is also gone.
    api.automations.listScoped.mockRejectedValue(new Error('offline'))
    api.automations.list.mockResolvedValue([])

    await renderPage()
    await settleHostQueries()
    // Only the pre-catalog projection could have supplied the clicked key before any host answered.
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
    // The ambient desktop list never held this row; only its captured owner can locate it.
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

describe('AutomationsPage edit destination', () => {
  it('names the edited row’s own host, and offers every host it could move to', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    addSshHost()
    addSshProject()
    runtimeHost([], [])

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })

    const resolution = mocks.editorDialog?.editDestination?.resolution
    expect(resolution?.status === 'ready' && resolution.entry.stableKey).toBe(DESKTOP_SELF_KEY)
    // Cross-authority moves create at the destination then delete at the source; keep both legal destinations offered.
    expect(mocks.editorDialog?.editDestination?.entries.map((entry) => entry.stableKey)).toContain(
      RUNTIME_SELF_KEY
    )
    expect(mocks.editorDialog?.editDestination?.moveWarning).toBeFalsy()
  })

  it.each(['legacy', 'chat'] as const)(
    'moves the saved %s record across authorities by creating there and deleting here',
    async (surface) => {
      const automation = makeAutomation({
        id: 'a-1',
        ...(surface === 'chat' ? { surface, extraAgentArgs: '--model opus' } : {})
      })
      api.automations.list.mockResolvedValue([])
      scopedList([automation])
      runtimeHost([], [])
      addRuntimeProject()
      if (surface === 'chat') {
        capableChatDestination()
      }
      const removed = Promise.withResolvers<void>()
      api.automations.delete.mockReturnValueOnce(removed.promise)
      runtimeCreateReturns(
        makeAutomation({
          id: 'a-moved',
          projectId: RUNTIME_REPO_ID,
          ...(surface === 'chat' ? { surface, extraAgentArgs: '--model opus' } : {})
        })
      )

      await renderPage()
      await settleHostQueries()
      await act(async () => {
        void mocks.listPanel?.openEditDialog(listedRow(automation.id))
      })
      await act(async () => {
        mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
      })

      expect(mocks.editorDialog?.editDestination?.moveWarning).toBeTruthy()

      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...(current as Record<string, unknown>),
          projectId: RUNTIME_REPO_ID,
          workspaceMode: 'existing',
          workspaceId: RUNTIME_WORKSPACE_ID
        }))
      })
      await save()

      expect(api.automations.update).not.toHaveBeenCalled()
      expect(createRpcCalls()).toHaveLength(1)
      expect(createRpcCalls()[0]?.[2]).toMatchObject({
        repo: `id:${RUNTIME_REPO_ID}`,
        dtstart: automation.dtstart
      })
      if (surface === 'chat') {
        expect(createRpcCalls()[0]?.[2]).toMatchObject({
          launchSetupPatch: {
            surface: 'chat',
            arguments: { kind: 'legacy-extras', value: '--model opus' }
          }
        })
      }
      expect(api.automations.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-1' }))
      const createIndex = mocks.callRuntimeRpc.mock.calls.findIndex(
        (call) => call[1] === 'automation.create'
      )
      expect(mocks.callRuntimeRpc.mock.invocationCallOrder[createIndex]).toBeLessThan(
        api.automations.delete.mock.invocationCallOrder[0]
      )
      expect(mocks.toastSuccess).not.toHaveBeenCalled()
      await act(async () => {
        removed.resolve()
      })
      await settleHostQueries()
      expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('moved'))
    }
  )

  it.each(['old', 'unknown', 'refused'] as const)(
    'preserves the saved Chat source when destination creation is %s',
    async (outcome) => {
      const automation = makeAutomation({
        id: 'a-1',
        surface: 'chat',
        extraAgentArgs: '--model opus'
      })
      api.automations.list.mockResolvedValue([])
      scopedList([automation])
      runtimeHost([], [])
      addRuntimeProject()
      capableChatDestination()
      runtimeCreateReturns(makeAutomation({ id: 'a-moved', surface: 'chat' }))
      await renderPage()
      await settleHostQueries()
      await act(async () => {
        void mocks.listPanel?.openEditDialog(listedRow(automation.id))
      })
      await act(async () => {
        mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
      })
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          projectId: RUNTIME_REPO_ID,
          workspaceMode: 'existing',
          workspaceId: RUNTIME_WORKSPACE_ID
        }))
      })
      const { resetAutomationCapabilityProbes } = await import('./automation-scoped-list-client')
      resetAutomationCapabilityProbes()
      mocks.getRuntimeEnvironmentStatus.mockClear()
      if (outcome === 'old') {
        mocks.getRuntimeEnvironmentStatus.mockResolvedValue({
          capabilities: CHAT_CAPABILITIES.filter(
            (capability) => capability !== AUTOMATION_SURFACE_RUNTIME_CAPABILITY
          )
        })
      } else if (outcome === 'unknown') {
        mocks.getRuntimeEnvironmentStatus.mockRejectedValue(new Error('capabilities unavailable'))
      } else {
        const previous = mocks.callRuntimeRpc.getMockImplementation()
        mocks.callRuntimeRpc.mockImplementation(async (...args) => {
          if (args[1] === 'automation.create') {
            throw new Error('destination refused create')
          }
          return await previous?.(...args)
        })
      }
      await save()
      expect(mocks.getRuntimeEnvironmentStatus).toHaveBeenCalled()
      expect(createRpcCalls()).toHaveLength(outcome === 'refused' ? 1 : 0)
      if (outcome === 'old') {
        expect(mocks.editorDialog?.notice?.message).toContain('run automations in Chat')
      }
      if (outcome === 'refused') {
        expect(createRpcCalls()[0]?.[2]).toMatchObject({ launchSetupPatch: { surface: 'chat' } })
      }
      expect(api.automations.delete).not.toHaveBeenCalled()
      expect(mocks.toastSuccess).not.toHaveBeenCalled()
      expect(mocks.editorDialog?.open).toBe(true)
      expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    }
  )

  it('moves when the destination project has the same host-local id', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    runtimeHost([], [])
    addCollidingRuntimeProject()
    runtimeCreateReturns(makeAutomation({ id: 'a-moved', projectId: REPO_ID }))

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    await save()

    expect(createRpcCalls()).toHaveLength(1)
    expect(createRpcCalls()[0]?.[2]).toMatchObject({ repo: `id:${REPO_ID}` })
    expect(api.automations.delete).toHaveBeenCalled()
  })

  it('reuses the move creation key on retry even when the schedule changed', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    runtimeHost([], [])
    addRuntimeProject()
    // Transport may fail after create commits; retries need the identical creationKey to avoid duplicates.
    let failCreate = true
    const previous = mocks.callRuntimeRpc.getMockImplementation()
    mocks.callRuntimeRpc.mockImplementation(
      async (target: unknown, method: string, params: unknown, options: unknown) => {
        if (method === 'automation.create') {
          if (failCreate) {
            failCreate = false
            throw new Error('socket hang up')
          }
          return { automation: makeAutomation({ id: 'a-moved', projectId: RUNTIME_REPO_ID }) }
        }
        return await previous?.(target, method, params, options)
      }
    )

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        projectId: RUNTIME_REPO_ID,
        workspaceMode: 'existing',
        workspaceId: RUNTIME_WORKSPACE_ID,
        // Changed schedules mint dtstart per attempt; this volatile field must not re-key a move.
        preset: 'custom',
        customSchedule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0'
      }))
    })

    const realNow = Date.now.bind(Date)
    let clockSkew = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockSkew)
    try {
      await save()
      clockSkew = 5000
      await save()
    } finally {
      nowSpy.mockRestore()
    }

    const creationKeys = createRpcCalls().map(
      (call) => (call[2] as { creationKey?: string }).creationKey
    )
    expect(creationKeys).toHaveLength(2)
    expect(creationKeys[0]).toBeTruthy()
    expect(creationKeys[1]).toBe(creationKeys[0])
    expect(api.automations.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-1' }))
  })

  it('reports a kept saved-Chat original as two live copies, never as a completed move', async () => {
    const automation = makeAutomation({
      id: 'a-1',
      surface: 'chat',
      extraAgentArgs: '--model opus'
    })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    runtimeHost([], [])
    addRuntimeProject()
    capableChatDestination()
    runtimeCreateReturns(
      makeAutomation({
        id: 'a-moved',
        projectId: RUNTIME_REPO_ID,
        surface: 'chat',
        extraAgentArgs: '--model opus'
      })
    )
    api.automations.delete.mockRejectedValue(new Error('gone away'))

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        projectId: RUNTIME_REPO_ID,
        workspaceMode: 'existing',
        workspaceId: RUNTIME_WORKSPACE_ID
      }))
    })
    await save()

    expect(createRpcCalls()).toHaveLength(1)
    expect(createRpcCalls()[0]?.[2]).toMatchObject({
      launchSetupPatch: {
        surface: 'chat',
        arguments: { kind: 'legacy-extras', value: '--model opus' }
      }
    })
    expect(api.automations.delete).toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('could not be deleted'))
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('moves the record to the host the user picks, clearing the stranded project', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    addSshHost()
    addSshProject()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.editDestination?.onSelect(SSH_HOST_KEY)
    })

    // Keeping the local project selected only defers the same refusal to submit.
    expect(mocks.editorDialog?.repos?.map((repo) => repo.id)).toEqual([SSH_REPO_ID])
    expect(mocks.editorDialog?.draft?.projectId).toBe('')

    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        projectId: SSH_REPO_ID,
        workspaceMode: 'new_per_run',
        workspaceId: ''
      }))
    })
    await save()

    expect(api.automations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: { selector: { kind: 'ssh', targetId: SSH_TARGET_ID, targetGeneration: 1 } }
      })
    )
  })
})
