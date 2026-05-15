// Why: defines the wire shape carried by the JSON-RPC `agent.hook` notification
// the relay sends to Orca. Consumed by `src/relay/agent-hook-server.ts` (which
// produces it after the shared listener parses an HTTP POST) and by
// `src/main/agent-hooks/server.ts` (which ingests it via `ingestRemote`).
//
// Lives in `shared/` because the relay deliberately has no Electron dependency
// (cf. `src/relay/protocol.ts` header). `agent-hook-types.ts` is reserved for
// the renderer-bound IPC + installer contract; this module is the wire envelope
// between Orca's main process and the remote relay.
//
// Per the design doc:
// - The relay normalizes; Orca routes. The envelope's `payload` field has
//   already been through `normalizeHookPayload` (which calls
//   `parseAgentStatusPayload` → `normalizeAgentStatusObject`) on the relay
//   side. Orca's `ingestRemote` re-runs the canonical payload normalizer at
//   the SSH trust boundary before caching or persisting, so relay skew or a
//   buggy remote process cannot poison main-process state.
// - The wire `connectionId` is **always `null`**: a `connectionId` is Orca's
//   local handle on an `ssh2` connection, not a wire identity. Orca stamps the
//   real value on receive from `mux` identity inside `ingestRemote`.
// - The wire `version` and `env` fields are forwarded from the agent CLI's
//   POST body so Orca's warn-once protocol diagnostics still fire. The relay
//   default env is `remote`, a location marker ignored by dev-vs-prod checks.

import type { ParsedAgentStatusPayload } from './agent-status-types'

// Why: the local hook server knows the discriminator from URL pathname routing
// (`/hook/<source>`); the relay equally must tag each forwarded notification
// with the same value so Orca can attribute the event back to the right CLI.
// Promoted from `src/main/agent-hooks/server.ts` so the relay can import it
// without dragging Electron in (the shared listener module is the only place
// that consumes it from the relay side).
export type AgentHookSource =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor'
  | 'pi'
  | 'droid'
  | 'grok'

/** Env marker used by the remote relay. It is a transport/location marker, not
 *  a dev-vs-prod build tag, so main-process env mismatch diagnostics ignore it. */
export const REMOTE_AGENT_HOOK_ENV = 'remote' as const

/** Wire envelope for a single hook event flowing relay → Orca. */
export type AgentHookRelayEnvelope = {
  source: AgentHookSource
  paneKey: string
  tabId?: string
  worktreeId?: string
  /** Always `null` on the wire — relay does not know Orca's local connectionId. */
  connectionId: null
  /** Forwarded from the agent CLI POST body. The relay default is `remote`,
   *  which marks transport location rather than dev/prod build env. */
  env?: string
  /** Forwarded verbatim from the agent CLI POST body. Lets Orca's warn-once
   *  protocol-version diagnostic fire on remote events the same as on local. */
  version?: string
  /** Pre-normalized status payload from the relay's `normalizeHookPayload`.
   *  Orca's `ingestRemote` validates it again at the SSH trust boundary. */
  payload: ParsedAgentStatusPayload
}

/** JSON-RPC notification method name carried over the relay control channel. */
export const AGENT_HOOK_NOTIFICATION_METHOD = 'agent.hook' as const

/** JSON-RPC request method Orca issues after `--connect` reattach to ask the
 *  relay to replay its per-paneKey last-payload cache. See §5 Path 3 of the
 *  design doc for the race that ruled out push-on-`setWrite`. */
export const AGENT_HOOK_REQUEST_REPLAY_METHOD = 'agent_hook.requestReplay' as const

/** JSON-RPC request method Orca issues at session-ready to ship the
 *  OpenCode/Pi plugin source files to the relay so it can materialize the
 *  per-PTY overlay dirs on the remote. */
export const AGENT_HOOK_INSTALL_PLUGINS_METHOD = 'agent_hook.installPlugins' as const

/** Feature-flag env var. Read once at process start by Orca and the relay.
 *  Absent / empty / "0" = off; anything else = on. See §8 of the design doc
 *  for the gate locations. */
export const ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV = 'ORCA_FEATURE_REMOTE_AGENT_HOOKS' as const

export function isRemoteAgentHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]
  if (raw === undefined) {
    return false
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === '0') {
    return false
  }
  return true
}
