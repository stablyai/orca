// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'

/** Choose, display and revalidate the storage destination explicitly; workspace execution cannot infer authority, and stale destinations must preserve the refused form. */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { unscopedAutomationListRows } from './automation-list-row-identity'
import {
  addRuntimeProject,
  api,
  installAutomationsPageHarness,
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
import { listedRow } from './automations-page-listed-items'
import { makeAutomation, makeWorktree, REPO_ID, WORKSPACE_ID } from './automations-page-fixtures'
import {
  CHAT_CAPABILITIES,
  createRpcCalls,
  draftRecord,
  holdRuntimeSave,
  learnRuntimeAgents,
  observeRuntimeIncarnation,
  openCreateDialogFor,
  runtimeCreateReturns,
  save
} from './automations-page-actions-test-harness'
import { getDefaultSettings } from '../../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import {
  addSshHost,
  addSshProject,
  capableChatDestination,
  DESKTOP_SELF_KEY,
  observeRuntimeChat,
  RUNTIME_SELF_KEY,
  SSH_HOST_KEY,
  SSH_REPO_ID,
  SSH_TARGET_ID
} from './automations-page-destination-fixtures'

installAutomationsPageHarness()

describe('AutomationsPage create destination', () => {
  it.each(['default-off', 'explicit'] as const)(
    'creates %s Terminal on the selected runtime while Chat observation is unavailable',
    async (selection) => {
      api.automations.list.mockResolvedValue([])
      scopedList([])
      runtimeHost([], [])
      runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
      mocks.state.runtimeStatusByEnvironmentId = new Map()
      addRuntimeProject()
      if (selection === 'explicit') {
        mocks.state.settings = {
          ...getDefaultSettings('/tmp'),
          nativeChatProviders: EVERY_AGENT_CHAT
        }
      }
      mocks.state.automationHostFilter = RUNTIME_SELF_FILTER

      await renderPage()
      await settleHostQueries()
      await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
      if (selection === 'explicit') {
        await act(async () => {
          mocks.editorDialog?.onDraftChange((current) => ({
            ...draftRecord(current),
            surface: 'terminal'
          }))
        })
      }
      await save()

      // Send the runtime’s own repo ID to its authority; the desktop is always the client authority, not the selected host.
      expect(api.automations.create).not.toHaveBeenCalled()
      expect(createRpcCalls()).toHaveLength(1)
      expect(createRpcCalls()[0]?.[0]).toEqual({ kind: 'environment', environmentId: RUNTIME_ID })
      expect(createRpcCalls()[0]?.[2]).not.toHaveProperty('launchSetupPatch')
      expect(createRpcCalls()[0]?.[3]).toMatchObject({ expectedEnvironmentPairingRevision: 4 })
      expect(createRpcCalls()[0]?.[2]).toMatchObject({
        repo: `id:${RUNTIME_REPO_ID}`,
        workspace: `id:${RUNTIME_WORKSPACE_ID}`,
        destination: { selector: { kind: 'self' } }
      })
    }
  )

  it.each([true, false])(
    'retains native intent through unknown support, then saves the known %s outcome',
    async (supported) => {
      api.automations.list.mockResolvedValue([])
      scopedList([])
      runtimeHost([], [])
      addRuntimeProject()
      mocks.state.settings = {
        ...getDefaultSettings('/tmp'),
        nativeChatProviders: EVERY_AGENT_CHAT
      }
      mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
      runtimeCreateReturns(makeAutomation({ id: 'a-new' }))
      observeRuntimeChat(null)
      if (supported) {
        observeRuntimeIncarnation('A')
      }
      const page = await renderPage()
      await settleHostQueries()
      await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          agentId: supported ? 'pi' : 'claude',
          extraAgentArgs: '--model opus',
          reuseSession: false
        }))
      })
      await save()
      expect(createRpcCalls()).toHaveLength(0)
      expect(api.automations.create).not.toHaveBeenCalled()
      expect(mocks.editorDialog?.open).toBe(true)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          surface: 'chat'
        }))
      })
      await save()
      expect(createRpcCalls()).toHaveLength(0)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          surface: undefined
        }))
      })

      capableChatDestination()
      if (supported) {
        observeRuntimeIncarnation('A')
        await learnRuntimeAgents('A', ['pi'])
      }
      if (!supported) {
        observeRuntimeChat(
          CHAT_CAPABILITIES.filter(
            (capability) => capability !== STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
          )
        )
      }
      await page.rerender()
      await save()
      expect(mocks.toastError.mock.calls).toEqual([])
      expect(mocks.editorDialog?.notice).toBeFalsy()
      expect(createRpcCalls()).toHaveLength(1)
      if (supported) {
        expect(createRpcCalls()[0]?.[2]).toMatchObject({
          launchSetupPatch: {
            surface: 'chat',
            arguments: { kind: 'legacy-extras', value: '--model opus' }
          }
        })
      } else {
        expect(createRpcCalls()[0]?.[2]).not.toHaveProperty('launchSetupPatch')
        expect(createRpcCalls()[0]?.[2]).toMatchObject({ extraAgentArgs: '--model opus' })
      }
    }
  )

  it('retains admitted native Chat when support becomes unknown during the actual hook await', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    addRuntimeProject()
    capableChatDestination()
    mocks.state.settings = { ...getDefaultSettings('/tmp'), nativeChatProviders: EVERY_AGENT_CHAT }
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    runtimeCreateReturns(makeAutomation({ id: 'a-new', surface: 'chat' }))
    const { checkRuntimeHooks } = await import('@/runtime/runtime-hooks-client')
    const held = Promise.withResolvers<HookCheckResult>()
    vi.mocked(checkRuntimeHooks).mockReturnValue(held.promise)
    try {
      const page = await renderPage()
      await settleHostQueries()
      await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          workspaceMode: 'new_per_run',
          workspaceId: '',
          extraAgentArgs: '--model opus'
        }))
      })
      await save()
      expect(checkRuntimeHooks).toHaveBeenCalledWith(`runtime:${RUNTIME_ID}`, RUNTIME_REPO_ID, {})
      expect(createRpcCalls()).toHaveLength(0)
      observeRuntimeChat(null)
      await page.rerender()
      await act(async () => {
        held.resolve({ status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false })
      })
      await settleHostQueries()
      expect(createRpcCalls()).toHaveLength(1)
      expect(createRpcCalls()[0]?.[2]).toMatchObject({
        launchSetupPatch: {
          surface: 'chat',
          arguments: { kind: 'legacy-extras', value: '--model opus' }
        }
      })
    } finally {
      held.resolve({ status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false })
      vi.mocked(checkRuntimeHooks).mockResolvedValue({
        status: 'ok',
        hasHooks: false,
        hooks: null,
        mayNeedUpdate: false
      })
    }
  })

  it.each([
    {
      name: 'implicit Chat / unknown',
      initial: ['pi'],
      late: undefined,
      surface: undefined,
      expected: 'chat'
    },
    {
      name: 'implicit Chat / exclusion',
      initial: ['pi'],
      late: [],
      surface: undefined,
      expected: 'terminal'
    },
    {
      name: 'explicit Chat / exclusion',
      initial: ['pi'],
      late: [],
      surface: 'chat' as const,
      expected: 'chat'
    },
    {
      name: 'admitted Terminal / unknown',
      initial: [],
      late: undefined,
      surface: undefined,
      expected: 'terminal'
    },
    {
      name: 'admitted Terminal / positive',
      initial: [],
      late: ['pi'],
      surface: undefined,
      expected: 'terminal'
    }
  ])(
    'preserves the admitted operation across the real await: $name',
    async ({ initial, late, surface, expected }) => {
      const held = await holdRuntimeSave(surface ? { surface } : {}, initial)
      if (surface) {
        expect(mocks.editorDialog?.draft).toHaveProperty('surface', surface)
      } else {
        expect(mocks.editorDialog?.draft).not.toHaveProperty('surface')
      }
      observeRuntimeIncarnation('B')
      if (late) {
        await learnRuntimeAgents('B', late)
      }
      await held.page.rerender()
      await held.release()
      expect(createRpcCalls()).toHaveLength(1)
      expect(createRpcCalls()[0]?.[0]).toEqual({ kind: 'environment', environmentId: RUNTIME_ID })
      expect(createRpcCalls()[0]?.[3]).toMatchObject({ expectedEnvironmentPairingRevision: 4 })
      if (expected === 'chat') {
        expect(createRpcCalls()[0]?.[2]).toMatchObject({ launchSetupPatch: { surface: 'chat' } })
      } else {
        expect(createRpcCalls()[0]?.[2]).not.toHaveProperty('launchSetupPatch')
      }
      if (surface) {
        expect(mocks.editorDialog?.draft).toHaveProperty('surface', surface)
      } else {
        expect(mocks.editorDialog?.draft).not.toHaveProperty('surface')
      }
      expect(mocks.toastSuccess).toHaveBeenCalledOnce()
    }
  )

  it('retains atomic Chat arguments through a failed current-runtime read and reaches real lower refusal', async () => {
    const held = await holdRuntimeSave({ extraAgentArgs: '--model opus' })
    observeRuntimeIncarnation('B')
    const previous = mocks.callRuntimeRpc.getMockImplementation()
    mocks.callRuntimeRpc.mockImplementation(async (target, method, params, options) => {
      if (method === 'agentSession.agents') {
        throw new Error('offline')
      }
      if (method === 'automation.create') {
        throw new Error('host refuses create')
      }
      return await previous?.(target, method, params, options)
    })
    const { loadHostStructuredAgents } = await import('@/runtime/host-structured-agents')
    const { REGISTERED_CHAT_CAPABILITIES } = await import('./automations-page-actions-test-harness')
    await loadHostStructuredAgents(`runtime:${RUNTIME_ID}`, REGISTERED_CHAT_CAPABILITIES, 'B')
    await held.page.rerender()
    await held.release()
    expect(createRpcCalls()).toHaveLength(1)
    expect(createRpcCalls()[0]?.[2]).toMatchObject({
      launchSetupPatch: {
        surface: 'chat',
        arguments: { kind: 'legacy-extras', value: '--model opus' }
      }
    })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.open).toBe(true)
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
  })

  it('refuses a desktop project for a runtime destination instead of sending its id', async () => {
    // Reject desktop repo IDs before sending them to a runtime that cannot resolve them (repo_not_found).
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
    expect(createRpcCalls()).toHaveLength(0)
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })

  it('refuses a runtime-owned project under the desktop destination', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addRuntimeProject()
    mocks.state.runtimeStatusByEnvironmentId = new Map([
      [RUNTIME_ID, { status: { capabilities: [] } }]
    ])

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
    await save()

    // A missing connection ID does not prove desktop ownership; this project belongs to the runtime.
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
    expect(createRpcCalls()).toHaveLength(0)
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

    expect(createRpcCalls()).toHaveLength(1)
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

    // Same-name local/SSH projects are ambiguous unless the picker is scoped to the destination.
    expect(mocks.editorDialog?.repos?.map((repo) => repo.id)).toEqual([SSH_REPO_ID])
  })

  it('keeps same-id workspace choices on the selected host and omits unstamped twins', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()
    addSshProject()
    const remote = mocks.state.repos.find((repo) => repo.id === SSH_REPO_ID)!
    mocks.state.repos = [...mocks.state.repos, { ...remote, connectionId: null }]
    const remoteRow = makeWorktree({
      id: 'remote-ws',
      repoId: SSH_REPO_ID,
      hostId: `ssh:${SSH_TARGET_ID}`
    })
    mocks.state.worktreesByRepo = {
      ...mocks.state.worktreesByRepo,
      [SSH_REPO_ID]: [
        makeWorktree({ id: 'legacy-ws', repoId: SSH_REPO_ID, hostId: undefined }),
        makeWorktree({ id: 'local-ws', repoId: SSH_REPO_ID, hostId: 'local' }),
        remoteRow
      ]
    }
    mocks.state.activeWorktreeId = 'legacy-ws'
    mocks.worktreeMap.set('legacy-ws', mocks.state.worktreesByRepo[SSH_REPO_ID]![0])
    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    expect(mocks.editorDialog?.createDestination?.resolution.status).toBe('choice-required')
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })
    expect(mocks.editorDialog?.draft?.projectId).toBe(SSH_REPO_ID)
    expect(mocks.editorDialog?.draft?.workspaceId).toBe('remote-ws')
    expect(mocks.editorDialog?.worktrees?.map((row) => row.id)).toEqual(['remote-ws'])
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

    expect(createRpcCalls()).toHaveLength(0)
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })
})

describe('AutomationsPage edit fencing', () => {
  async function renameOpenDraft(): Promise<unknown> {
    expect(mocks.editorDialog?.open).toBe(true)
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => {
        if (!current || typeof current !== 'object') {
          throw new Error('Missing editor draft')
        }
        return { ...current, name: 'Renamed' }
      })
    })
    return structuredClone(mocks.editorDialog?.draft)
  }

  async function expectUnavailableSave(draft: unknown): Promise<void> {
    const { ensureHooksConfirmed } = await import('@/lib/ensure-hooks-confirmed')
    const { checkRuntimeHooks } = await import('@/runtime/runtime-hooks-client')
    // Opening may read hooks; Save must refuse before any further probe.
    vi.mocked(checkRuntimeHooks).mockClear()
    await save()

    expect(api.automations.update).not.toHaveBeenCalled()
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(api.automations.delete).not.toHaveBeenCalled()
    expect(api.automations.runNow).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc.mock.calls.map((call) => call[1])).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^automation\.(?:create|update|delete|runNow|precheck)$/)
      ])
    )
    expect(ensureHooksConfirmed).not.toHaveBeenCalled()
    expect(checkRuntimeHooks).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.open).toBe(true)
    expect(mocks.editorDialog?.draft).toEqual(draft)
    expect(mocks.toastError).toHaveBeenCalledWith(
      'This automation is no longer available. Refresh and try again.'
    )
  }

  it('refuses a save when the captured record disappears after the editor opens', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    const draft = await renameOpenDraft()
    scopedList([])
    await expectUnavailableSave(draft)
  })

  it('opens a legacy snapshot but refuses Save without a fresh owner-addressable record', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.listScoped.mockRejectedValue(new Error('offline'))
    api.automations.list.mockResolvedValue([])

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openEditDialog(unscopedAutomationListRows([automation])[0]!)
    })
    const draft = await renameOpenDraft()
    await expectUnavailableSave(draft)
  })
})

describe('AutomationsPage create admission', () => {
  it('keeps the create button available while every offered host is ineligible', async () => {
    // Keep Create available to open the dialog that explains repairs, even before any host is eligible.
    api.automations.listScoped.mockRejectedValue(new Error('offline'))
    api.automations.list.mockResolvedValue([])

    await renderPage()
    await settleHostQueries()

    expect(mocks.listPanel?.canCreateAutomation).toBe(true)
  })

  it('refuses a mismatched create destination before the hooks trust prompt', async () => {
    // Refuse the mismatched destination before asking the user to trust setup hooks.
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addRuntimeProject()
    // A default-run hook would have prompted for trust under the old save order.
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
