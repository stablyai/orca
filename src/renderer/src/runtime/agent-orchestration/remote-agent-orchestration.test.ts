import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeStructuredChatTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { buildAgentRowLineageTree } from '@/components/dashboard/rows/agent-row-lineage-model'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  canonicalOrchestrationForRow,
  selectVisibleAgentOrchestration
} from './visible-agent-orchestration'
import { refreshRemoteAgentOrchestration } from './remote-agent-orchestration'

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
      unifiedTabsByWorktree: {
        'wt-wsl': [remoteChat('assistant'), remoteChat('orchestrator'), remoteChat('worker')]
      }
    })
  })

  it('nests a remote host chat worker under its coordinator after a local graph reply', async () => {
    callRuntimeRpc.mockResolvedValue({ contexts: structuredClone(HOST_CONTEXTS) })
    refreshRemoteAgentOrchestration(ENVIRONMENT, { reconnected: true })
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

  it('keeps the remote producer when the local reply re-sends the held map', async () => {
    callRuntimeRpc.mockResolvedValue({ contexts: structuredClone(HOST_CONTEXTS) })
    refreshRemoteAgentOrchestration(ENVIRONMENT, { reconnected: true })
    await settle()
    const held = useAppStore.getState().runtimeAgentOrchestrationByPaneKey
    useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey(held)
    expect(canonicalOrchestrationForRow(useAppStore.getState(), WORKER)?.parentPaneKey).toBe(
      ORCHESTRATOR
    )
  })

  it('stops asking a host without the method until it reconnects', async () => {
    callRuntimeRpc.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'r1',
        ok: false,
        error: { code: 'method_not_found', message: 'missing' }
      })
    )
    refreshRemoteAgentOrchestration(ENVIRONMENT, { reconnected: true })
    await settle()
    refreshRemoteAgentOrchestration(ENVIRONMENT)
    await settle()
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    refreshRemoteAgentOrchestration(ENVIRONMENT, { reconnected: true })
    await settle()
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })
})
