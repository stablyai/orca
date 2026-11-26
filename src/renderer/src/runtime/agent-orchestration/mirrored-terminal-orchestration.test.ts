import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeStructuredChatTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import {
  chatPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
import { orchestrationForStatusRows } from './remote-row-orchestration'
import { canonicalOrchestrationForRow } from './visible-agent-orchestration'
import { setWorkerKeptOpen } from './worker-auto-close'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))

// A runtime host keys panes `<hostTab>:<leaf>`; this window mirrors its tab as `web-terminal-<hostTab>`.
const ENVIRONMENT = 'wsl-ubuntu'
const HOST = toRuntimeExecutionHostId(ENVIRONMENT)
const LEAF = '11111111-1111-4111-8111-111111111111'
const HOST_TAB = 'a6729fc3-0000-4000-8000-00000000000a'
const MIRRORED_TAB = toWebTerminalSurfaceTabId(HOST_TAB)
const HOST_TERMINAL = makePaneKey(HOST_TAB, LEAF)
const MIRRORED_TERMINAL = makePaneKey(MIRRORED_TAB, LEAF)
const paneKeyOf = (sessionId: string) => chatPaneKey(sessionId)
const ASSISTANT = paneKeyOf('assistant')
const WORKER = paneKeyOf('worker')

function remoteChat(sessionId: string) {
  return makeStructuredChatTab({
    id: structuredAgentSessionTabId(sessionId),
    entityId: sessionId,
    worktreeId: 'wt-wsl',
    agentSessionAgent: 'claude',
    executionHostId: HOST
  })
}

describe('a remote host’s terminal rows, mirrored here as web-terminal tabs', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {},
      remoteAgentOrchestrationByHost: {},
      unifiedTabsByWorktree: { 'wt-wsl': [remoteChat('assistant')] },
      tabsByWorktree: { 'wt-wsl': [makeTab({ id: MIRRORED_TAB, worktreeId: 'wt-wsl' })] },
      ptyIdsByTabId: { [MIRRORED_TAB]: [toRemoteRuntimePtyId('pty-1', ENVIRONMENT)] }
    })
  })

  it('nests a host terminal worker under the host chat coordinator by its mirrored key', () => {
    const store = useAppStore.getState()
    store.setRuntimeAgentOrchestrationByPaneKey(
      { [HOST_TERMINAL]: { taskId: 'task-t', dispatchId: 'dispatch-t', parentPaneKey: ASSISTANT } },
      HOST
    )
    const rows = orchestrationForStatusRows(useAppStore.getState())
    expect(rows[HOST_TERMINAL]).toBeUndefined()
    expect(rows[MIRRORED_TERMINAL]?.parentPaneKey).toBe(ASSISTANT)
    // A host chat worker names a host terminal coordinator by the host's own key.
    store.setRuntimeAgentOrchestrationByPaneKey(
      { [WORKER]: { taskId: 'task-w', dispatchId: 'dispatch-w', parentPaneKey: HOST_TERMINAL } },
      HOST
    )
    useAppStore.setState({ unifiedTabsByWorktree: { 'wt-wsl': [remoteChat('worker')] } })
    expect(orchestrationForStatusRows(useAppStore.getState())[WORKER]?.parentPaneKey).toBe(
      MIRRORED_TERMINAL
    )
  })

  it('reads the host’s context for a mirrored terminal row', () => {
    useAppStore.getState().setRuntimeAgentOrchestrationByPaneKey(
      {
        [HOST_TERMINAL]: { taskId: 'task-t', dispatchId: 'dispatch-t', parentPaneKey: ASSISTANT }
      },
      HOST
    )
    const context = canonicalOrchestrationForRow(useAppStore.getState(), MIRRORED_TERMINAL)
    expect(context?.dispatchId).toBe('dispatch-t')
    expect(context?.parentPaneKey).toBe(ASSISTANT)
  })

  it('asks the host about a mirrored worker pane by the host’s own key', async () => {
    callRuntimeRpc.mockResolvedValue({ kept: true, closesAt: null })
    await setWorkerKeptOpen(
      { kind: 'environment', environmentId: ENVIRONMENT },
      { paneKey: MIRRORED_TERMINAL },
      true
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENVIRONMENT },
      'orchestration.workerKeepOpen',
      { paneKey: HOST_TERMINAL, keep: true },
      expect.anything()
    )
  })
})
