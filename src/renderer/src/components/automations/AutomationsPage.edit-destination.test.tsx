// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'

import {
  addRuntimeProject,
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  runtimeHost,
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

import type { AutomationListRow } from './automation-list-row-identity'
import { capableChatDestination, RUNTIME_SELF_KEY } from './automations-page-destination-fixtures'

import { listedRow } from './automations-page-listed-items'
import { makeAutomation } from './automations-page-fixtures'

installAutomationsPageHarness()

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

  it('refuses the save when the captured record cannot be re-read', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    mocks.state.settings = { ...getDefaultSettings('/tmp'), nativeChatProviders: EVERY_AGENT_CHAT }
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

    expect(api.automations.update).not.toHaveBeenCalled()
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(api.automations.delete).not.toHaveBeenCalled()
    expect(api.automations.runNow).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.open).toBe(true)
    expect(mocks.editorDialog?.draft).toMatchObject({ name: 'Renamed' })
    expect(mocks.toastError).toHaveBeenCalledWith(
      'This automation is no longer available. Refresh and try again.'
    )
  })
})

describe('AutomationsPage edit destination', () => {
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
})
