import type { AgentProcessPresence } from './agent-process-presence'
import type { ClaudeSettledRequest } from './agent-hook-listener/claude-settled-permission-requests'
// Relay normalizes; main revalidates at the SSH trust boundary and routes. Wire connectionId stays null until ingestRemote stamps mux identity. CLI version/env survive forwarding; remote marks location, not build type. Keep wire envelopes separate from renderer IPC/install contracts without Electron dependencies.

import { createHash } from 'node:crypto'

import type {
  AgentSubagentSnapshot,
  ParsedAgentStatusPayload,
  TurnEndDisposition
} from './agent-status-types'
import type { AgentProviderSessionMetadata } from './agent-session-resume'

// The relay must retain the URL-derived source discriminator for CLI attribution.
const AGENT_HOOK_SOURCES = [
  'claude',
  'codex',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'codebuddy',
  'gemini',
  'antigravity',
  'amp',
  'opencode',
  'opencode2',
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
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'kiro'
] as const

export type AgentHookSource = (typeof AGENT_HOOK_SOURCES)[number]

const AGENT_HOOK_SOURCE_SET: ReadonlySet<string> = new Set(AGENT_HOOK_SOURCES)

export function isAgentHookSource(value: unknown): value is AgentHookSource {
  return typeof value === 'string' && AGENT_HOOK_SOURCE_SET.has(value)
}

/** Remote transport location; excluded from dev/prod mismatch checks. */
export const REMOTE_AGENT_HOOK_ENV = 'remote' as const

/** Wire envelope for a single hook event flowing relay → Orca. */
export type AgentHookRelayEnvelope = {
  source: AgentHookSource
  paneKey: string
  agentPresence?: AgentProcessPresence
  /** Ephemeral Orca launch identity stamped into the PTY env for this process. */
  launchToken?: string
  /** Optional support proof and exact host turn fence for explicit interrupt reconciliation. */
  hostTurnRevision?: string
  tabId?: string
  worktreeId?: string
  /** Always `null` on the wire — relay does not know Orca's local connectionId. */
  connectionId: null
  /** Distinguish same-prompt retries from cached-prompt tool events. */
  hasExplicitPrompt?: boolean
  /** In-memory turn dedupe key; excluded from telemetry. */
  promptInteractionKey?: string
  /** Hook discriminator preserved for main-process transition rules. */
  hookEventName?: string
  /** Provider-owned turn identity (Claude UUID or opaque Grok prompt id). */
  providerPromptId?: string
  /** The row belongs to an observed Grok prompt boundary whose opaque id may be absent. */
  grokPromptBoundary?: true
  /** Active Claude compact generation, keyed by provider prompt identity. */
  compactTrigger?: 'manual' | 'auto'
  /** Claude tool execution id, when the source hook provides one. */
  toolUseId?: string
  /** Optional, replay only: Claude requests the relay saw end while this receiver may have been away. */
  claudeSettledRequests?: readonly ClaudeSettledRequest[]
  /** Claude subagent identity, when the source hook provides one. */
  toolAgentId?: string
  /** Claude teammate name carried by TeammateIdle. */
  teammateName?: string
  /** Claude agent type, used only as a lower-confidence identity fallback. */
  toolAgentType?: string
  /** Provider-owned conversation/session id needed to resume a sleeping agent. */
  providerSession?: AgentProviderSessionMetadata
  /** True when this envelope updates resume identity without changing turn status. */
  providerSessionOnly?: boolean
  /** True when the relay is replaying its cache after Orca reconnects. */
  isReplay?: boolean
  /** The relay's turn-end stamp (see AgentHookEventPayload.turnEndedAt); older relays omit it. */
  turnEndedAt?: number
  /** How the relay identified that end; older relays omit it (legacy). */
  turnEndDisposition?: TurnEndDisposition
  /** Claude live work the child list does not show (a shell, a cron, an owed task notification), for input-interrupt inference on the receiving host. */
  claudeRunningNonAgentTask?: boolean
  /** Forward CLI env; the relay default remote names location, not build type. */
  env?: string
  /** Forward CLI version so remote protocol mismatches remain diagnosable. */
  version?: string
  /** Pre-normalized by the relay; ingestRemote validates again at the SSH trust boundary. */
  evidenceAgeMs?: number
  payload: ParsedAgentStatusPayload
}

/** Older clients ignore the null payload; newer clients clear only the selected projection. */
export type AgentHookUnavailableEnvelope = {
  source: 'opencode' | 'opencode2'
  paneKey: string
  tabId?: string
  worktreeId?: string
  launchToken?: string
  connectionId: null
  statusUnavailable: true
  payload: null
}

/** JSON-RPC notification method name carried over the relay control channel. */
export const AGENT_HOOK_NOTIFICATION_METHOD = 'agent.hook' as const

/** Mark fields shed to fit a frame so receivers distinguish truncation from clearing; rosters include a digest. */
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

/** Restore a shed roster only with matching digest and turn identity or live children could disappear and permit hibernation. Never restore prose from a prior turn. */
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

/** Request cache replay after wiring handlers; eager setWrite pushes can arrive before listeners and be lost. */
export const AGENT_HOOK_REQUEST_REPLAY_METHOD = 'agent_hook.requestReplay' as const

/** Ship OpenCode/Pi plugin sources at session-ready so the relay can materialize remote overlays. */
export const AGENT_HOOK_INSTALL_PLUGINS_METHOD = 'agent_hook.installPlugins' as const

/** Read each WSL relay start; 0 disables remote hooks. */
export const ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV = 'ORCA_FEATURE_REMOTE_AGENT_HOOKS' as const

export function isWslAgentHookRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]
  return raw === undefined || !['', '0'].includes(raw.trim())
}
