import { createAgentStatusOscProcessor } from '@/components/terminal-pane/agent-status-osc'
import { subscribeToPtyData, subscribeToPtyExit } from '@/components/terminal-pane/pty-dispatcher'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRemoteRuntimeTerminalMultiplexer } from '@/runtime/remote-runtime-terminal-multiplexer'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'
import { useAppStore } from '@/store'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'

export async function observeExistingAutomationSession(args: {
  ptyId: string
  paneKey: string
  runId: string
  onData: (chunk: string) => void
  onAgentStatus: (payload: ParsedAgentStatusPayload) => void
  onExit: (code: number) => void
}): Promise<() => void> {
  const { ptyId, paneKey, runId, onData, onExit } = args
  const processAgentStatus = createAgentStatusOscProcessor()
  const handleData = (data: string): void => {
    onData(data)
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
      useAppStore.getState().setAgentStatus(paneKey, payload, undefined)
      args.onAgentStatus(payload)
    }
  }

  if (isRemoteRuntimePtyId(ptyId)) {
    let disposed = false
    const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
    const runtimeTarget = ownerEnvironmentId
      ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
      : getActiveRuntimeTarget(useAppStore.getState().settings)
    const terminal = getRemoteRuntimeTerminalHandle(ptyId)
    if (runtimeTarget.kind !== 'environment' || !terminal) {
      return () => {}
    }
    const stream = await getRemoteRuntimeTerminalMultiplexer(
      runtimeTarget.environmentId
    ).subscribeTerminal({
      terminal,
      client: { id: `desktop:automation-reuse:${runId}`, type: 'desktop' },
      callbacks: {
        onData: handleData,
        onSnapshot: () => {}
      }
    })
    void callRuntimeRpc<{ wait: { exitCode?: number | null } }>(
      runtimeTarget,
      'terminal.wait',
      { terminal, for: 'exit' },
      { timeoutMs: 24 * 60 * 60 * 1000 }
    )
      .then((result) => {
        if (!disposed) {
          onExit(result.wait.exitCode ?? 0)
        }
      })
      .catch(() => {})
    return () => {
      disposed = true
      stream.close()
    }
  }

  const unsubscribeData = subscribeToPtyData(ptyId, handleData)
  const unsubscribeExit = subscribeToPtyExit(ptyId, onExit)
  return () => {
    unsubscribeData()
    unsubscribeExit()
  }
}
