// Versioned agent-reference DTOs: the persisted owners of agent references that
// are not catalog authoring (terminal quick commands, commit-message agent
// choice, Source Control recipe defaults). Synced as revisioned full snapshots
// in their own RPC frame, separate from the catalog snapshot, so the two
// domains never compete under the transport's 1 MiB frame cap.

import type { CommitMessageAiSettings, TerminalQuickCommand } from './types'
import type { SourceControlAiSettings } from './source-control-ai-types'
import type { AgentProjectionStatus } from './agent-catalog-snapshot'
import type { AgentLaunchIntentKind } from './agent-launch-contract'

export type AgentReferenceSnapshot = {
  version: 1
  revision: number
  terminalQuickCommands: TerminalQuickCommand[]
  commitMessageAi?: CommitMessageAiSettings
  sourceControlAi?: SourceControlAiSettings
  // Repo-specific Source Control overrides remain in their existing repo DTO,
  // but use the same owner-specific mutation/version rules.
}

// Uncapped authoring/repair view over local preload IPC only.
export type LocalAgentReferenceSnapshot = AgentReferenceSnapshot & {
  projection: AgentProjectionStatus
}

export type AgentReferenceProjectionError = {
  version: 1
  revision: number
  code: 'agent_reference_payload_too_large'
  maxBytes: 524_288
}

export type AgentReferenceMutationResult<
  TSnapshot extends AgentReferenceSnapshot | LocalAgentReferenceSnapshot
> =
  | {
      ok: true
      referenceRevision: number
      catalogRevision: number // may advance when the final tombstone reference is removed
      snapshot: TSnapshot
    }
  | {
      ok: false
      code:
        | 'reference_revision_conflict'
        | 'invalid_agent_reference'
        | 'invalid_reference_field'
        | 'agent_reference_payload_too_large'
        // The durable settings write failed and was rolled back: nothing persisted.
        | 'agent_reference_write_failed'
      referenceRevision: number
      catalogRevision: number
      snapshot?: TSnapshot // current snapshot on revision conflict
      owner?: 'quick-command' | 'commit-message' | 'source-control-recipe'
      field?: string
      reason?: 'unknown_agent' | 'disabled_agent' | 'bounds' | 'conflict'
    }

/** Owner-specific v1 reference mutations. Field-level stale-reference rule,
 *  enforced host-side: an omitted agent field or the exact currently stored
 *  (possibly stale) id preserves the proven stored reference while other fields
 *  save; a different agent must be a currently effectively enabled live
 *  identity; explicit null clears it. A client can never mint persisted
 *  fallback authority by echoing a stale id into a different row/owner. */
export type AgentReferenceMutation =
  | { kind: 'quick-command-save'; command: TerminalQuickCommand }
  | { kind: 'quick-command-delete'; id: string }
  | { kind: 'quick-commands-reorder'; orderedIds: string[] }
  | { kind: 'commit-message-update'; changes: Partial<CommitMessageAiSettings> }
  | { kind: 'source-control-update'; changes: Partial<SourceControlAiSettings> }

export type AgentReferenceMutationRequest = {
  expectedReferenceRevision: number
  mutation: AgentReferenceMutation
}

// Re-exported so existing importers of this module keep working; the
// canonical definition lives in agent-launch-contract.ts (L8-#2 — this was
// previously a second, independently-maintained copy of the same union).
export type { AgentLaunchIntentKind }

/** Persisted-owner kinds; maps one-to-one onto the tombstone reference index. */
export type AgentReferenceOwnerKind =
  | 'default'
  | 'quick-command'
  | 'commit-message'
  | 'source-control-recipe'
  | 'automation'
  | 'background'
  | 'orchestration'
  | 'workspace'
  | 'session'

/** Per-owner reference count for delete confirmation and "Review references".
 *  Owner kind + count only — never prompt/config/env. Count -1 means the
 *  owner's store could not be read. */
export type AgentReferenceSummary = {
  owner: AgentReferenceOwnerKind
  count: number
}

/** A base-disable impact count (§973). `count` is the number of readable
 *  matches; `atLeast` is true when a contributing owner store could not be read,
 *  so the true total may be higher — the "at least N" analog of the summary's
 *  per-owner -1. Counts only: never a label or config. */
export type BaseDisableImpactCount = {
  count: number
  atLeast: boolean
}

/** Host-computed impact of disabling a built-in base (§973), for the confirm
 *  dialog. `savedReferences` counts persisted-owner references whose launch
 *  blocks — the base id itself plus any custom derivative of it (baseAgent === X)
 *  — excluding sessions, which are reported separately. `resumableSessions`
 *  counts resumable records on that base (covering direct and derivative launches
 *  alike). Enabled-derivative counts stay client-side off the catalog snapshot. */
export type BaseDisableImpact = {
  savedReferences: BaseDisableImpactCount
  resumableSessions: BaseDisableImpactCount
}
