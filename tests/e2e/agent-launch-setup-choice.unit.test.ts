import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RuntimeClient,
  RuntimeClientError,
  RuntimeRpcFailureError
} from '../../src/cli/runtime-client'
import { createWorktreeWithAgent } from '../../src/cli/handlers/worktree-create-agent-launch'
import { formatCliError } from '../../src/cli/cli-error'
import { AGENT_LAUNCH_RUNTIME_CAPABILITIES } from '../../src/shared/agent-launch-runtime-capability'
import { WorktreeCreateSetupChoiceRefusedError } from '../../src/main/runtime/worktree-create-setup-choice-refusal'
import { openTestAgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabase } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { mapDispatcherError } from '../../src/main/runtime/rpc/dispatcher-error-response'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from '../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import { AGENT_LAUNCH_METHODS } from '../../src/main/runtime/rpc/methods/agent-launch'

const SETUP_CHOICE = 'Setup decision required for this repository'
const create = { repo: 'id:repo-1', name: 'task', activate: false }
let directory: string
let store: Awaited<ReturnType<typeof openTestAgentSessionRecordStore>>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-launch-setup-choice-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await closeTestJournalHostDatabase(directory)
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function hostClient(runtime: ReturnType<typeof runtimeStub>) {
  const client = new RuntimeClient(directory, 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(async (name, params) => {
    const meta = { runtimeId: 'runtime-1' }
    if (name === 'status.get') {
      return {
        id: 'status',
        ok: true,
        result: { capabilities: [...AGENT_LAUNCH_RUNTIME_CAPABILITIES] },
        _meta: meta
      }
    }
    if (name === 'worktree.show') {
      return { id: 'show', ok: true, result: { worktree: { id: 'wt-new' } }, _meta: meta }
    }
    expect(name).toBe('agent.launchReplay')
    const method = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
    try {
      const result = await method.handler(method.params.parse(params), rpcContext(runtime, {}))
      return { id: 'launch', ok: true, result, _meta: meta }
    } catch (error) {
      const response = mapDispatcherError(
        { id: 'launch', authToken: 'token', method: name, params },
        meta,
        error
      )
      if (response.ok) {
        throw new Error('Expected an error response')
      }
      throw new RuntimeRpcFailureError(response)
    }
  })
  return client
}

function launch(
  client: RuntimeClient,
  options: { operationId?: string; setupDecision?: 'run' | 'skip' } = {}
) {
  return createWorktreeWithAgent({
    client,
    flags: new Map(),
    create: {
      ...create,
      ...(options.setupDecision ? { setupDecision: options.setupDecision } : {})
    },
    launch: {
      agent: 'codex',
      ...(options.operationId ? { operationId: options.operationId } : {})
    },
    json: true
  })
}

describe('CLI setup choice across durable launch admission', () => {
  it('preserves the choice and its guidance on first refusal and after reopening the store', async () => {
    const first = runtimeStub({ settings: {} })
    first.createManagedWorktree.mockRejectedValue(
      new WorktreeCreateSetupChoiceRefusedError(SETUP_CHOICE)
    )
    const firstError = await launch(hostClient(first)).catch((error: unknown) => error)
    expect(formatCliError(firstError)).toContain('--setup run')
    expect(formatCliError(firstError)).toContain('--setup skip')
    expect(formatCliError(firstError)).not.toContain('Remove --retry-launch')
    expect(firstError).toMatchObject({ message: SETUP_CHOICE })
    expect(first.createTerminal).not.toHaveBeenCalled()
    const row = store.listOperationRows()[0]
    expect(row?.outcome).toMatchObject({ status: 'failed', code: SETUP_CHOICE })
    if (!row) {
      throw new Error('Missing failed launch row')
    }

    setAgentLaunchRecordStore(null)
    await closeTestJournalHostDatabase(directory)
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
    const replay = runtimeStub({ settings: {} })
    const replayError = await launch(hostClient(replay), { operationId: row.operationId }).catch(
      (error: unknown) => error
    )
    expect(replayError).toMatchObject({ message: SETUP_CHOICE })
    expect(formatCliError(replayError)).toContain('--setup run')
    expect(formatCliError(replayError)).toContain('Remove --retry-launch')
    expect(replay.createManagedWorktree).not.toHaveBeenCalled()
    await expect(
      launch(hostClient(replay), { operationId: row.operationId, setupDecision: 'skip' })
    ).rejects.toMatchObject({ code: 'agent_session_operation_conflict' })
  })

  it('changes setup with a fresh ID only after replay proves the lost refusal had no effects', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const runtime = runtimeStub({ settings: {} })
    runtime.createManagedWorktree.mockRejectedValueOnce(
      new WorktreeCreateSetupChoiceRefusedError(SETUP_CHOICE)
    )
    const client = hostClient(runtime)
    const hostCall = vi.mocked(client.call).getMockImplementation()
    if (!hostCall) {
      throw new Error('Missing host adapter')
    }
    let dropReply = true
    vi.mocked(client.call).mockImplementation(async (name, params) => {
      try {
        return await hostCall(name, params)
      } catch (error) {
        if (name === 'agent.launchReplay' && dropReply) {
          dropReply = false
          throw new RuntimeClientError('runtime_unavailable', 'Connection closed before response')
        }
        throw error
      }
    })
    const uncertain = await launch(client).catch((error: unknown) => error)
    expect(uncertain).toMatchObject({ code: 'agent_session_operation_unknown' })
    expect(formatCliError(uncertain)).toContain('Keep that ID on every retry')
    expect(formatCliError(uncertain)).not.toContain('Remove --retry-launch')
    const row = store.listOperationRows()[0]
    if (!row) {
      throw new Error('Missing refused operation')
    }
    const refused = await launch(client, { operationId: row.operationId }).catch(
      (error: unknown) => error
    )
    expect(formatCliError(refused)).toContain('--setup run')
    expect(formatCliError(refused)).toContain('--setup skip')
    expect(formatCliError(refused)).toContain('Remove --retry-launch')
    expect(formatCliError(refused)).toContain('new launch ID')
    await expect(
      launch(client, { operationId: row.operationId, setupDecision: 'skip' })
    ).rejects.toMatchObject({ code: 'agent_session_operation_conflict' })
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    await launch(client, { setupDecision: 'skip' })
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(2)
    const rows = store.listOperationRows()
    expect(rows).toHaveLength(2)
    expect(rows.find((entry) => entry.operationId !== row.operationId)?.outcome.status).toBe(
      'succeeded'
    )
  })

  it('keeps a matching error after workspace creation unknown', async () => {
    const runtime = runtimeStub({ settings: {} })
    runtime.createManagedWorktree.mockResolvedValue({
      worktree: { id: 'wt-new' },
      startupTerminal: undefined
    })
    runtime.createTerminal.mockRejectedValue(new Error(SETUP_CHOICE))
    const client = hostClient(runtime)
    await expect(launch(client)).rejects.toMatchObject({ code: 'agent_session_operation_unknown' })
    const row = store.listOperationRows()[0]
    expect(row?.outcome.status).toBe('unknown')
    if (!row) {
      throw new Error('Missing uncertain launch row')
    }
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(runtime.createTerminal).toHaveBeenCalledTimes(2)
    expect(runtime.createTerminal).toHaveBeenNthCalledWith(
      1,
      'id:wt-new',
      expect.objectContaining({ startupAgent: 'codex' })
    )
    expect(runtime.createTerminal).toHaveBeenNthCalledWith(2, 'id:wt-new', {
      surfaceOwner: false
    })
    await expect(launch(client, { operationId: row.operationId })).rejects.toMatchObject({
      code: 'agent_session_operation_unknown'
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(runtime.createTerminal).toHaveBeenCalledTimes(2)
  })

  it('does not infer an effect-free refusal from matching text alone', async () => {
    const runtime = runtimeStub({ settings: {} })
    runtime.createManagedWorktree.mockRejectedValue(new Error(SETUP_CHOICE))
    await expect(launch(hostClient(runtime))).rejects.toMatchObject({
      code: 'agent_session_operation_unknown'
    })
    expect(store.listOperationRows()[0]?.outcome.status).toBe('unknown')
  })
})
