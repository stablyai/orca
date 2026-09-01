// Host-only agent-launch contracts: the resolution request, the immutable
// launch snapshot, and the complete resolved launch. This module is shared only
// so startup/persistence code can type-check; renderer, mobile, and web runtime
// code MUST NOT import it (an architecture test enforces the boundary).
// `AgentLaunchSnapshot` is a host-persistence schema that may appear in shared
// session types but is explicitly redacted from every client transport.

import type { BuiltInTuiAgent, TuiAgent } from './types'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { AgentPromptInjectionMode, DraftPasteReadySignal } from './tui-agent-config'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { AgentKind } from './telemetry-events'
import type {
  AgentLaunchIntentKind,
  AgentLaunchFailure,
  AgentLaunchNotice
} from './agent-launch-contract'

export type AgentArgv = readonly [executable: string, ...args: string[]]

/** Stable host-produced target scope reusing the existing ExecutionHostId
 *  grammar ('local' | `ssh:${host}` | `runtime:${id}`) plus the `wsl:${distro}`
 *  variant this feature adds — HEAD's union cannot scope a distro. The snapshot
 *  copy is private persistence only; never returned, logged, or used as
 *  authorization. */
export type AgentLaunchExecutionHostId =
  | 'local'
  | `ssh:${string}`
  | `runtime:${string}`
  | `wsl:${string}`

export type AgentLaunchSnapshot = Readonly<{
  version: 1
  requestedAgent: TuiAgent
  baseAgent: BuiltInTuiAgent
  displayLabel: string
  mode: 'built-in' | 'custom' | 'safe-fallback'
  // Fully resolved command prefix + user argv; prompt/resume argv is excluded.
  argv: AgentArgv
  // Only user-configured agent env admitted by launch policy; never
  // process/Orca generated env.
  agentEnv: Readonly<Record<string, string>>
  // Resolved env disposition at capture time. Mobile/paired replay compares this
  // policy state (not env keys/values) to decide snapshot_definition_changed, so
  // a value-only edit can never leak through the comparison.
  capturedEnvPolicy: 'full' | 'withheld' | 'none'
  target: Readonly<{
    platform: NodeJS.Platform // terminal target, never phone/browser OS
    execution: 'native' | 'wsl'
    shell: AgentStartupShell
    isRemote: boolean
    executionHostId: AgentLaunchExecutionHostId
  }>
}>

export type LaunchIntent =
  | { kind: 'interactive'; client: 'desktop' | 'paired-web' | 'mobile' }
  | { kind: 'cli'; command: 'worktree-create' }
  | { kind: 'automation'; runId: string }
  | { kind: 'background'; attemptId: string; worktreeId: string }
  | { kind: 'orchestration'; taskId: string; dispatchId: string }
  | { kind: 'resume'; operation: 'resume' | 'fork'; client: 'desktop' | 'paired-web' | 'mobile' }

export type AgentReferenceAuthority =
  | {
      kind: 'persisted'
      owner:
        | 'default'
        | 'quick-command'
        | 'commit-message'
        | 'source-control-recipe'
        | 'automation'
        | 'background'
        | 'orchestration'
        | 'workspace'
        | 'session'
    }
  | { kind: 'live-selection' }
  | { kind: 'direct' }

export type ResolvedAgentLaunch = {
  requestedAgent: TuiAgent
  baseAgent: BuiltInTuiAgent
  displayLabel: string
  argv: AgentArgv
  /** Provider resume flags appended to the command on a resume/fork replay (e.g.
   *  `--resume <id>`), derived from the record's provider session — NOT part of
   *  the immutable snapshot argv and NOT persisted into the durable launch config,
   *  so it never pollutes a fresh relaunch. Absent on a non-resume launch. */
  resumeArgvSuffix?: readonly string[]
  agentEnv: Readonly<Record<string, string>>
  variables: {
    values: { repoPath: string | null; worktreePath: string | null }
    referenced: readonly ('repoPath' | 'worktreePath')[]
  }
  snapshot: AgentLaunchSnapshot
  policy: {
    intent: AgentLaunchIntentKind
    mode: AgentLaunchSnapshot['mode']
    client: 'desktop' | 'paired-web' | 'mobile' | 'cli' | 'host-service'
    isRemote: boolean
    platform: NodeJS.Platform
    promptInjectionMode: AgentPromptInjectionMode
    expectedProcess: string
    preflightTrust?: 'cursor' | 'copilot' | 'codex'
    draftPromptFlag?: string
    draftPromptEnvVar?: string
    draftPasteReadySignal?: DraftPasteReadySignal
    startupCommandDelivery?: StartupCommandDelivery
    env: 'full' | 'withheld' | 'none'
  }
  notices: readonly AgentLaunchNotice[]
  telemetry: { agentKind: AgentKind; usedCustomAgent: boolean }
  // Host-private relevant-input guard; never persisted, returned, or logged.
  admissionGuard: {
    fingerprint: string
    /** Config-only digest (path variables excluded) for U4's two-stage worktree
     *  recheck: stable between pre-create identity pinning and post-create final
     *  resolution, where the authoritative worktree path differs. */
    stableInputDigest: string
    basis: 'explicit' | 'default' | 'snapshot'
  }
}

export type AgentLaunchResolution =
  | { ok: true; launch: ResolvedAgentLaunch }
  | { ok: false; failure: AgentLaunchFailure }

export type ResolveAgentLaunchRequest = {
  selection: { kind: 'agent'; agent: TuiAgent } | { kind: 'default' }
  intent: LaunchIntent
  reference: AgentReferenceAuthority
  variables: { repoPath?: string | null; worktreePath?: string | null }
  platform: NodeJS.Platform // terminal target platform
  shell?: AgentStartupShell
  isRemote: boolean
  targetHomePath?: string | null
  // Stock detection for the target's baseline PATH; configured prefixes or an
  // effective user PATH override bypass this stock-name gate. null means
  // detection is unavailable (unknown), which never claims "not installed".
  detectedStockBaseAgents: ReadonlySet<BuiltInTuiAgent> | null
  executionHostId: AgentLaunchExecutionHostId
  /** Host-produced: whether the authoring→terminal transport is authenticated
   *  AND confidential (SSH, E2EE, or trust-bound TLS). Env-bearing resolution
   *  across hosts fails secure_env_transport_unavailable when false; undefined
   *  means same-host (no transport involved). Like detection, this is an input
   *  to the pure resolver — never derived inside it. */
  transportConfidentialityAvailable?: boolean
  persistedSnapshot?: AgentLaunchSnapshot
  /** The record's provider session, supplied only on a resume/fork replay so the
   *  resolver appends the provider resume flags to the replayed snapshot argv. The
   *  session key type is implied by `baseAgent`. */
  resumeProviderSession?: AgentProviderSessionMetadata
  /** Host-produced per-launch args (U7): a source-control recipe's stored
   *  `agentArgs`, resolved from settings by the host before resolution. Validated
   *  through the SAME v1 grammar/caps/secrets path as definition args and appended
   *  as a distinct band AFTER the definition argv and BEFORE the prompt argv. Still
   *  host-produced: the client only threads the recipe id via `sourceRecord`, plus the
   *  optional `unsavedAgentArgs` the host substitutes for the stored recipe args. */
  perLaunchArgs?: string
}
