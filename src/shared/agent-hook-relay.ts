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
// Invariants both ends rely on:
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

import { createHash } from 'node:crypto'

import type { AgentSubagentSnapshot, ParsedAgentStatusPayload } from './agent-status-types'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AgentHookTarget } from './agent-hook-types'

// Why: the local hook server knows the discriminator from URL pathname routing
// (`/hook/<source>`); the relay equally must tag each forwarded notification
// with the same value so Orca can attribute the event back to the right CLI.
// Promoted from `src/main/agent-hooks/server.ts` so the relay can import it
// without dragging Electron in (the shared listener module is the only place
// that consumes it from the relay side).
const AGENT_HOOK_SOURCES = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'amp',
  'opencode',
  'mimo-code',
  'cursor',
  'pi',
  'omp',
  'prime-agent',
  'droid',
  'command-code',
  'grok',
  'copilot',
  'hermes',
  'devin',
  'kimi'
] as const

export type AgentHookSource = (typeof AGENT_HOOK_SOURCES)[number]

const AGENT_HOOK_SOURCE_SET: ReadonlySet<string> = new Set(AGENT_HOOK_SOURCES)

export function isAgentHookSource(value: unknown): value is AgentHookSource {
  return typeof value === 'string' && AGENT_HOOK_SOURCE_SET.has(value)
}

/** Env marker used by the remote relay. It is a transport/location marker, not
 *  a dev-vs-prod build tag, so main-process env mismatch diagnostics ignore it. */
export const REMOTE_AGENT_HOOK_ENV = 'remote' as const

/** Wire envelope for a single hook event flowing relay → Orca. */
export type AgentHookRelayEnvelope = {
  source: AgentHookSource
  paneKey: string
  /** Ephemeral Orca launch identity stamped into the PTY env for this process. */
  launchToken?: string
  tabId?: string
  worktreeId?: string
  /** Always `null` on the wire — relay does not know Orca's local connectionId. */
  connectionId: null
  /** Preserved from the relay-side normalized hook event so Orca can
   *  distinguish a true same-prompt retry from a cached-prompt tool ping. */
  hasExplicitPrompt?: boolean
  /** Optional stable per-turn key from the relay-side listener. Used only for
   *  in-memory dedupe; never included in product telemetry payloads. */
  promptInteractionKey?: string
  /** Hook discriminator preserved for main-process transition rules. */
  hookEventName?: string
  /** Claude's provider-owned user-prompt UUID. */
  providerPromptId?: string
  /** Active Claude compact generation, keyed by provider prompt identity. */
  compactTrigger?: 'manual' | 'auto'
  /** Claude tool execution id, when the source hook provides one. */
  toolUseId?: string
  /** Claude subagent identity, when the source hook provides one. */
  toolAgentId?: string
  /** Claude agent type, used only as a lower-confidence identity fallback. */
  toolAgentType?: string
  /** Provider-owned conversation/session id needed to resume a sleeping agent. */
  providerSession?: AgentProviderSessionMetadata
  /** True when this envelope updates resume identity without changing turn status. */
  providerSessionOnly?: boolean
  /** True when the relay is replaying its cache after Orca reconnects. */
  isReplay?: boolean
  /** Claude background-work evidence for input-interrupt inference on the receiving host. */
  claudeRunningNonAgentTask?: boolean
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

/** Identifies optional payload fields the relay dropped to fit an oversized frame
 *  (see `src/relay/agent-hook-envelope-publication.ts`), so `ingestRemote` can tell
 *  "shed in transit" from "the agent cleared it"; rosters include their digest. */
export const AGENT_HOOK_SHED_FIELDS_KEY = 'shedFields' as const
const AGENT_HOOK_SHED_SUBAGENTS_DIGEST_PREFIX = 'subagents:sha256:'

function subagentRosterDigest(subagents: readonly AgentSubagentSnapshot[]): string {
  const stableRoster = subagents.map(({ id, state, startedAt, agentType, model, description }) => [
    id,
    state,
    startedAt,
    agentType ?? null,
    model ?? null,
    description ?? null
  ])
  return createHash('sha256').update(JSON.stringify(stableRoster)).digest('base64url')
}

/** Carries the dropped roster identity without carrying its full rows. */
export function createShedSubagentsField(subagents: readonly AgentSubagentSnapshot[]): string {
  return `${AGENT_HOOK_SHED_SUBAGENTS_DIGEST_PREFIX}${subagentRosterDigest(subagents)}`
}

function hasMatchingShedSubagentsField(
  shedFields: readonly unknown[],
  previous: ParsedAgentStatusPayload
): boolean {
  if (!previous.subagents) {
    return false
  }
  const expected = createShedSubagentsField(previous.subagents)
  return shedFields.some((field) => field === expected)
}

function hasMatchingTurnIdentity(
  payload: ParsedAgentStatusPayload,
  previous: ParsedAgentStatusPayload
): boolean {
  return (
    payload.prompt === previous.prompt &&
    payload.agentType === previous.agentType &&
    payload.model === previous.model
  )
}

/**
 * Re-attaches shed fields from Orca's cached payload for this pane, so a transport-level
 * truncation cannot read as a cleared field — an absent `subagents` blanks live child rows and
 * unblocks hibernation for a pane whose teammates are still running.
 *
 * `interactivePrompt` and `lastAssistantMessage` are deliberately not restored: cached prose can
 * belong to an earlier turn. A roster returns only when its wire digest and turn identity match.
 */
export function restoreShedStatusFields(
  payload: ParsedAgentStatusPayload,
  shedFields: unknown,
  previous: ParsedAgentStatusPayload | undefined
): ParsedAgentStatusPayload {
  if (!previous || !Array.isArray(shedFields) || shedFields.length === 0) {
    return payload
  }
  const subagents =
    payload.subagents === undefined &&
    hasMatchingTurnIdentity(payload, previous) &&
    hasMatchingShedSubagentsField(shedFields, previous)
      ? previous.subagents
      : undefined
  if (subagents === undefined) {
    return payload
  }
  return {
    ...payload,
    subagents
  }
}

/** JSON-RPC request method Orca issues after `--connect` reattach to ask the
 *  relay to replay its per-paneKey last-payload cache. Pull, not push: a relay
 *  that pushed on `setWrite` can emit before Orca has wired its `agent.hook`
 *  handler, and those notifications are dropped silently. */
export const AGENT_HOOK_REQUEST_REPLAY_METHOD = 'agent_hook.requestReplay' as const

/** JSON-RPC request method Orca issues at session-ready to ship the
 *  OpenCode/Pi plugin source files to the relay so it can materialize the
 *  overlay dirs on the remote. */
export const AGENT_HOOK_INSTALL_PLUGINS_METHOD = 'agent_hook.installPlugins' as const

/** JSON-RPC request method that asks the remote relay to install every
 *  managed hook using its local filesystem instead of WAN-bound SFTP. */
export const AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD = 'agent_hook.installManagedHooks' as const

export type AgentHookInstallManagedHooksParams = {
  /** SHA-256 fingerprint of the server key negotiated by Orca's SSH transport. */
  hostKeyFingerprint?: string
  /** Positively detected and enabled agents allowed to mutate remote config. */
  agents: readonly AgentHookTarget[]
}

/** Feature-flag env var. Read once at process start by Orca and the relay.
 *  Remote agent hooks ship as the default SSH behavior; set "0" to opt out. */
export const ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV = 'ORCA_FEATURE_REMOTE_AGENT_HOOKS' as const

export function isRemoteAgentHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]
  if (raw === undefined) {
    return true
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === '0') {
    return false
  }
  return true
}
