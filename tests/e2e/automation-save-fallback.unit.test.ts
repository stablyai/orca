// @vitest-environment happy-dom

import {
  installAutomationsPageHarness,
  mocks,
  RUNTIME_REPO_ID
} from '../../src/renderer/src/components/automations/automations-page-test-harness'
import {
  createRpcCalls,
  holdRuntimeSave,
  observeRuntimeIncarnation,
  REGISTERED_CHAT_CAPABILITIES
} from '../../src/renderer/src/components/automations/automations-page-actions-test-harness'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState
} from '../../src/main/persistence/persistence-test-harness'
import { AutomationCreate } from '../../src/shared/rpc-contract/automation-params'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('../../src/main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../src/main/telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
installAutomationsPageHarness()

it('settles the actual implicit late-false save with real final-store refusal of invalid Terminal extras', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-34332-save-'))
  testState.dir = root
  const disk = createStore()
  disk.addRepo(makeRepo({ id: RUNTIME_REPO_ID }))
  const before = disk.listAutomations()
  const create = vi.spyOn(disk, 'createAutomation')
  const held = await holdRuntimeSave({ agentId: 'claude', extraAgentArgs: '--resume x' })
  try {
    expect(mocks.editorDialog?.draft).not.toHaveProperty('surface')
    observeRuntimeIncarnation(
      'B',
      REGISTERED_CHAT_CAPABILITIES.filter((c) => c !== STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    )
    const previous = mocks.callRuntimeRpc.getMockImplementation()
    mocks.callRuntimeRpc.mockImplementation(async (target, method, payload, options) => {
      if (method !== 'automation.create') {
        return await previous?.(target, method, payload, options)
      }
      const {
        repo,
        workspace: _workspace,
        destination: _destination,
        workspaceMode,
        timezone,
        ...input
      } = AutomationCreate.parse(payload)
      expect(repo).toBe(`id:${RUNTIME_REPO_ID}`)
      if (workspaceMode !== 'new_per_run') {
        throw new Error('Expected actual new_per_run workspace mode')
      }
      if (typeof timezone !== 'string' || timezone.trim().length === 0) {
        throw new Error('Expected actual nonempty timezone')
      }
      return {
        automation: disk.createAutomation({
          ...input,
          workspaceMode,
          timezone,
          projectId: RUNTIME_REPO_ID
        })
      }
    })
    await held.page.rerender()
    await held.release()
    expect(createRpcCalls()).toHaveLength(1)
    expect(createRpcCalls()[0]?.[2]).not.toHaveProperty('launchSetupPatch')
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ extraAgentArgs: '--resume x' }))
    expect(create.mock.results[0]?.type).toBe('throw')
    expect(disk.listAutomations()).toEqual(before)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toContain('--resume')
    expect(mocks.editorDialog?.open).toBe(true)
    expect(mocks.editorDialog?.isSaving).toBe(false)
    disk.flush()
    await closeTestStores()
    const reloaded = createStore()
    expect(reloaded.listAutomations()).toEqual(before)
  } finally {
    await held.release()
    await closeTestStores()
    rmSync(root, { recursive: true, force: true })
  }
})
