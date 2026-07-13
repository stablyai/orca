import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { subscribeToPtyExit } from '@/components/terminal-pane/pty-dispatcher'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRemoteRuntimeTerminalMultiplexer } from '@/runtime/remote-runtime-terminal-multiplexer'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'
import { useAppStore } from '@/store'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { isMainTerminalSideEffectAuthorityForPty } from '@/components/terminal-pane/terminal-side-effect-facts-handler'

export async function observeExistingAutomationSession(args: {
  ptyId: string
  paneKey: string
  runId: string
  onData: (chunk: string) => void
  onAgentStatus: (payload: ParsedAgentStatusPayload) => void
  onExit: (code: number) => void
}): Promise<() => void> {
  const { ptyId, paneKey, runId, onData, onExit } = args
  // Why: for local/SSH PTYs main already parses OSC 9999 and routes it
  // through the hook server (agentStatus:set → store); writing here too
  // would race/duplicate that path. Remote-runtime bytes never transit local
  // main, and the kill switch restores the legacy write. The onAgentStatus
  // callback always fires — automation completion tracking stays here.
  const mainOwnsAgentStatusWrites =
    !isRemoteRuntimePtyId(ptyId) &&
    isMainTerminalSideEffectAuthorityForPty({
      settings: useAppStore.getState().settings,
      runtimeEnvironmentId: null
    })
  const processAgentStatus = createAgentStatusOscProcessor()
  const handleData = (data: string): void => {
    onData(data)
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
      if (!mainOwnsAgentStatusWrites) {
        useAppStore.getState().setAgentStatus(paneKey, payload, undefined)
      }
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
