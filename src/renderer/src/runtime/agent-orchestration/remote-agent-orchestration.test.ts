import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeStructuredChatTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { buildAgentRowLineageTree } from '@/components/dashboard/rows/agent-row-lineage-model'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  canonicalOrchestrationForRow,
  orchestrationForStatusRows,
  selectVisibleAgentOrchestration
} from './visible-agent-orchestration'
import {
  noteRemoteAgentOrchestrationChanged,
  parseRemoteAgentOrchestration,
  refreshRemoteAgentOrchestration
} from './remote-agent-orchestration'
import { advanceRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))

const ENVIRONMENT = 'wsl-ubuntu'
const HOST = toRuntimeExecutionHostId(ENVIRONMENT)
const paneKeyOf = (sessionId: string) =>
  structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
const ASSISTANT = paneKeyOf('assistant')
const ORCHESTRATOR = paneKeyOf('orchestrator')
const WORKER = paneKeyOf('worker')

// The host's `worktree ps` chain: worker > orchestrator > assistant, by the host's pane keys.
const HOST_CONTEXTS = {
  [ORCHESTRATOR]: { taskId: 'task-o', dispatchId: 'dispatch-o', parentPaneKey: ASSISTANT },
  [WORKER]: { taskId: 'task-w', dispatchId: 'dispatch-w', parentPaneKey: ORCHESTRATOR }
}

function remoteChat(sessionId: string) {
  return makeStructuredChatTab({
    id: structuredAgentSessionTabId(sessionId),
    entityId: sessionId,
    worktreeId: 'wt-wsl',
    agentSessionAgent: 'claude',
    executionHostId: HOST
  })
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

function sidebarTree() {
  const state = useAppStore.getState()
  const orchestration = selectVisibleAgentOrchestration(state)
  const rows = [ASSISTANT, ORCHESTRATOR, WORKER].map((paneKey) => ({
    paneKey,
    entry: { orchestration: orchestration[paneKey] }
  }))
  return buildAgentRowLineageTree(rows)
}

describe('remote host worker lineage', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {},
      remoteAgentOrchestrationByHost: {},
      removedRuntimeEnvironmentIds: new Set(),
      unifiedTabsByWorktree: {
        'wt-wsl': [remoteChat('assistant'), remoteChat('orchestrator'), remoteChat('worker')]
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('nests a remote host chat worker under its coordinator after a local graph reply', async () => {
    callRuntimeRpc.mockResolvedValue({ contexts: structuredClone(HOST_CONTEXTS) })
    refreshRemoteAgentOrchestration(ENVIRONMENT)
    await settle()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENVIRONMENT },
      'agentActivity.orchestration',
      undefined,
      expect.objectContaining({ background: true })
    )

    // This computer's own graph reply knows none of the host's Dispatches.
    useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey({})
    const tree = sidebarTree()
    expect(tree.rootRows.map((row) => row.paneKey)).toEqual([ASSISTANT])
    expect(tree.childrenByParentPaneKey.get(ASSISTANT)?.map((row) => row.paneKey)).toEqual([
      ORCHESTRATOR
    ])
    expect(tree.childrenByParentPaneKey.get(ORCHESTRATOR)?.map((row) => row.paneKey)).toEqual([
      WORKER
    ])
  })

  it('keeps a local and a remote context that share a pane key through each other’s updates', async () => {
    const local = { taskId: 'task-local', dispatchId: 'dispatch-local' }
    callRuntimeRpc.mockResolvedValue({ contexts: structuredClone(HOST_CONTEXTS) })
    for (let round = 0; round < 2; round += 1) {
      useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey({ [WORKER]: { ...local } })
      refreshRemoteAgentOrchestration(ENVIRONMENT)
      await settle()
    }
    useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey({ [WORKER]: { ...local } })
    const state = useAppStore.getState()
    expect(state.runtimeAgentOrchestrationByPaneKey[WORKER]?.dispatchId).toBe('dispatch-local')
    expect(state.remoteAgentOrchestrationByHost[HOST]?.[WORKER]?.dispatchId).toBe('dispatch-w')
    // The row runs on the host, so it reads the host's context, never this computer's.
    expect(canonicalOrchestrationForRow(state, WORKER)?.dispatchId).toBe('dispatch-w')
    expect(selectVisibleAgentOrchestration(state)[WORKER]?.parentPaneKey).toBe(ORCHESTRATOR)
  })

  it('stops asking a host without the method until its connection changes', async () => {
    callRuntimeRpc.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'r1',
        ok: false,
        error: { code: 'method_not_found', message: 'missing' }
      })
    )
    refreshRemoteAgentOrchestration('old-host')
    await settle()
    // A repo change or worker event on the same connection must not re-ask it.
    refreshRemoteAgentOrchestration('old-host')
    await settle()
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    advanceRuntimeEnvironmentConnectionGeneration('old-host')
    refreshRemoteAgentOrchestration('old-host')
    await settle()
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })

  it('re-asks a host without the method when its new connection lands after the wake refresh', async () => {
    callRuntimeRpc.mockRejectedValueOnce(
      new RuntimeRpcCallError({
        id: 'r2',
        ok: false,
        error: { code: 'method_not_found', message: 'missing' }
      })
    )
    callRuntimeRpc.mockResolvedValue({ contexts: {} })
    refreshRemoteAgentOrchestration('wake-host')
    await settle()
    // The wake's refresh ran first and skipped; the new runtime id publishes afterwards.
    refreshRemoteAgentOrchestration('wake-host')
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    advanceRuntimeEnvironmentConnectionGeneration('wake-host')
    useAppStore.setState({})
    await settle()
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })

  it('answers a burst of host writes with one read after it settles', async () => {
    vi.useFakeTimers()
    callRuntimeRpc.mockResolvedValue({ contexts: {} })
    for (let index = 0; index < 5; index += 1) {
      noteRemoteAgentOrchestrationChanged('busy-host')
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('retries a failed read twice with backoff, then waits for the next event', async () => {
    vi.useFakeTimers()
    callRuntimeRpc.mockRejectedValue(new Error('timeout'))
    refreshRemoteAgentOrchestration('retry-host')
    await settle()
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(3)
    for (const call of callRuntimeRpc.mock.calls) {
      expect(call[3]).toEqual(expect.objectContaining({ background: true }))
    }
  })

  it('reads nothing for a removed host and drops its lineage when the catalog loses it', async () => {
    callRuntimeRpc.mockResolvedValue({ contexts: structuredClone(HOST_CONTEXTS) })
    useAppStore.setState({
      runtimeEnvironments: [publicRuntimeEnvironment({ id: ENVIRONMENT })],
      remoteAgentOrchestrationByHost: { [HOST]: structuredClone(HOST_CONTEXTS) }
    })
    useAppStore.getState().setRuntimeEnvironments([])
    expect(useAppStore.getState().remoteAgentOrchestrationByHost[HOST]).toBeUndefined()
    refreshRemoteAgentOrchestration(ENVIRONMENT)
    await settle()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('keeps only well-formed contexts from a reply', () => {
    expect(
      parseRemoteAgentOrchestration({
        contexts: {
          [WORKER]: HOST_CONTEXTS[WORKER],
          bad: { taskId: 7 },
          ['x'.repeat(600)]: HOST_CONTEXTS[WORKER]
        }
      })
    ).toEqual({ [WORKER]: HOST_CONTEXTS[WORKER] })
    expect(parseRemoteAgentOrchestration({ contexts: [] })).toEqual({})
    expect(parseRemoteAgentOrchestration(null)).toEqual({})
  })
})

describe('this computer’s rows while a remote host has lineage', () => {
  it('reads a local chat worker’s context unchanged, even when its parent key names a remote chat', () => {
    const localWorker = makeStructuredChatTab({
      id: structuredAgentSessionTabId('local-worker'),
      entityId: 'local-worker',
      worktreeId: 'wt-local',
      agentSessionAgent: 'claude',
      executionHostId: 'local'
    })
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {},
      remoteAgentOrchestrationByHost: {},
      unifiedTabsByWorktree: {
        'wt-local': [localWorker],
        'wt-wsl': [remoteChat('assistant'), remoteChat('orchestrator'), remoteChat('worker')]
      }
    })
    const localKey = paneKeyOf('local-worker')
    // The local parent's key is spelled like a chat the remote host runs here.
    const local = { taskId: 'task-l', dispatchId: 'dispatch-l', parentPaneKey: ASSISTANT }
    const store = useAppStore.getState()
    store.setRuntimeAgentOrchestrationByPaneKey({ [localKey]: local })
    store.setRuntimeAgentOrchestrationByPaneKey(structuredClone(HOST_CONTEXTS), HOST)
    const rows = orchestrationForStatusRows(useAppStore.getState())
    expect(rows[localKey]).toBe(useAppStore.getState().runtimeAgentOrchestrationByPaneKey[localKey])
    expect(rows[localKey]?.parentPaneKey).toBe(ASSISTANT)
    expect(rows[WORKER]?.parentPaneKey).toBe(ORCHESTRATOR)
  })
})
