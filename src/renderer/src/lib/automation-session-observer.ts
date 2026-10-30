import type {
  TerminalOutputBoundary,
  RuntimeTerminalRead,
  RuntimeTerminalResolvePane
} from '../../../shared/runtime-terminal-contracts'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { subscribeToPtyExit } from '@/components/terminal-pane/pty-dispatcher'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getRemoteRuntimeTerminalMultiplexer } from '@/runtime/remote-runtime-terminal-multiplexer'
import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { getRemoteRuntimePtyOwner } from '@/runtime/runtime-terminal-stream'
import { useAppStore } from '@/store'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import { runtimeWaitExitCode } from '@/lib/agent-background-session-exit'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { isMainTerminalSideEffectAuthorityForPty } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'

export async function observeExistingAutomationSession(args: {
  ptyId: string
  paneKey: string
  runId: string
  onData: (chunk: string) => void
  onAgentStatus: (payload: ParsedAgentStatusPayload) => void
  onExit: (code: number) => void
}): Promise<() => void> {
  const { ptyId, paneKey, runId, onData, onExit } = args
  // Main owns local/SSH OSC 9999 writes unless the kill switch restores legacy behavior; runtime bytes still need renderer writes. Completion callbacks always fire here.
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
        const state = useAppStore.getState()
        const routing = resolveLiveAgentStatusConnectionRouting({ state, paneKey, ptyId })
        // Delayed reuse observers must not update panes rebound to another host’s colliding IDs.
        if (routing) {
          state.setAgentStatus(
            paneKey,
            {
              ...payload,
              observation: rendererAgentStatusObservations.observe(paneKey, {
                origin: 'osc',
                observedAt: Date.now(),
                kind: 'snapshot'
              })
            },
            undefined,
            undefined,
            routing
          )
        }
      }
      args.onAgentStatus(payload)
    }
  }

  if (isRemoteRuntimePtyId(ptyId)) {
    let disposed = false
    const exitWait = new AbortController()
    const owner = getRemoteRuntimePtyOwner(ptyId)
    if (!owner) {
      return () => {}
    }
    const { target: runtimeTarget, terminal } = owner
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
      { timeoutMs: 24 * 60 * 60 * 1000, signal: exitWait.signal }
    )
      .then((result) => {
        if (!disposed) {
          onExit(runtimeWaitExitCode(result.wait))
        }
      })
      .catch(() => {})
    return () => {
      disposed = true
      // Why: frees the server's long-wait slot; the reused terminal stays open.
      exitWait.abort()
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

/** Capture before a reused prompt; fresh PTYs own their output from offset zero. */
export async function captureAutomationTerminalOutputBoundary(args: {
  paneKey: string
  ptyId: string
  worktreeId: string
  freshLaunch?: boolean
}): Promise<TerminalOutputBoundary | null> {
  try {
    const owner = isRemoteRuntimePtyId(args.ptyId) ? getRemoteRuntimePtyOwner(args.ptyId) : null
    if (isRemoteRuntimePtyId(args.ptyId) && !owner) {
      return null
    }
    const target = owner?.target ?? { kind: 'local' as const }
    const handle =
      owner?.terminal ??
      (
        await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
          target,
          'terminal.resolvePane',
          {
            paneKey: args.paneKey,
            worktreeId: args.worktreeId
          }
        )
      ).terminal.handle
    const { terminal } = await callRuntimeRpc<{ terminal: RuntimeTerminalRead }>(
      target,
      'terminal.read',
      {
        terminal: handle,
        limit: 1
      }
    )
    const boundary = terminal.outputBoundary
    return boundary ? { ...boundary, ...(args.freshLaunch ? { offset: 0 } : {}) } : null
  } catch {
    // Missing output provenance on older or disconnected hosts cannot prove a bootstrap failure.
    return null
  }
}
