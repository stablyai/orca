import { runBestEffortAgentBackgroundCleanups } from '@/lib/agent-background-session-cleanup'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'

type RemoteRunObservationArgs = {
  settings: Parameters<typeof subscribeToRuntimeTerminalData>[0]
  ptyId: string
  clientId: string
  runtimeTarget: Extract<RuntimeClientTarget, { kind: 'environment' }>
  terminal: string
  onData: (data: string) => void
  onExit: (code: number) => void
}

export type AgentBackgroundRunObservation = {
  dispose: () => void
  startRemote: (args: RemoteRunObservationArgs) => Promise<void>
  setDataUnsubscribe: (unsubscribe: () => void) => void
  setExitUnsubscribe: (unsubscribe: () => void) => void
}

export function createAgentBackgroundRunObservation(): AgentBackgroundRunObservation {
  const exitWaitController = new AbortController()
  let disposed = false
  let unsubscribeData = (): void => {}
  let unsubscribeExit = (): void => {}
  // An awaited remote subscription can resolve after disposal; close its late handle immediately.
  const retainUnlessDisposed = (unsubscribe: () => void): (() => void) => {
    if (!disposed) {
      return unsubscribe
    }
    runBestEffortAgentBackgroundCleanups(unsubscribe)
    return () => {}
  }

  return {
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      exitWaitController.abort()
      runBestEffortAgentBackgroundCleanups(unsubscribeExit, unsubscribeData)
      unsubscribeData = (): void => {}
      unsubscribeExit = (): void => {}
    },
    startRemote: async (args) => {
      unsubscribeData = retainUnlessDisposed(
        await subscribeToRuntimeTerminalData(args.settings, args.ptyId, args.clientId, args.onData)
      )
      void callRuntimeRpc<{ wait: { exitCode?: number | null } }>(
        args.runtimeTarget,
        'terminal.wait',
        { terminal: args.terminal, for: 'exit' },
        { timeoutMs: 24 * 60 * 60 * 1000, signal: exitWaitController.signal }
      )
        .then((result) => args.onExit(result.wait.exitCode ?? 0))
        .catch(() => {})
    },
    setDataUnsubscribe: (unsubscribe) => {
      unsubscribeData = retainUnlessDisposed(unsubscribe)
    },
    setExitUnsubscribe: (unsubscribe) => {
      unsubscribeExit = retainUnlessDisposed(unsubscribe)
    }
  }
}
