import type { ExecutionHostId } from './execution-host'

/** Mirrors the DAP session lifecycle: initialize -> launch/attach -> configurationDone -> running/paused -> terminate. */
export type DebugSessionState =
  | 'initializing'
  | 'launching'
  | 'configuring'
  | 'running'
  | 'paused'
  | 'terminating'
  | 'terminated'

export type DebugAdapterConfig = {
  type: 'node' | 'chrome'
  request: 'launch' | 'attach'
  /** Adapter process command + args, e.g. the vscode-js-debug DAP server entrypoint. Empty on day 1 — filled in by the Wave 1 adapter workstream. */
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  /** Adapter-specific launch/attach request arguments, passed through verbatim. */
  adapterArgs?: Record<string, unknown>
}

export type DebugSession = {
  id: string
  worktreeId: string
  hostId: ExecutionHostId
  config: DebugAdapterConfig
  state: DebugSessionState
  /** Thread id the UI is currently focused on once the session pauses. */
  activeThreadId?: number
}

/** A DAP `event` message (`stopped`, `output`, `terminated`, ...), passed through verbatim from the adapter. */
export type DebugAdapterEventMessage = {
  seq: number
  type: 'event'
  event: string
  body?: unknown
}

/** Payload pushed to the renderer over the single multiplexed `debug:event` IPC channel. */
export type DebugSessionEvent =
  | { sessionId: string; type: 'stateChanged'; state: DebugSessionState }
  | { sessionId: string; type: 'adapterEvent'; event: DebugAdapterEventMessage }
  | { sessionId: string; type: 'stderr'; text: string }
