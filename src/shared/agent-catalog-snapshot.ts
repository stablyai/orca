// Versioned agent-catalog DTOs. The remote snapshot is an authoritative,
// revisioned full replacement (receivers replace, never merge) and is env-free:
// no custom env key or value may appear in any remote projection, cache, or
// mutation result. Local (Electron preload IPC only) shapes carry repair
// metadata and byte summaries, still never env values in list form.

import type {
  BuiltInTuiAgent,
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  TuiAgent
} from './types'
import type {
  MAX_AGENT_CATALOG_PROJECTION_BYTES,
  MAX_LOCAL_AGENT_CATALOG_BYTES
} from './custom-tui-agents'
import type { AgentCatalogSchemaTooNew } from './data-recovery'

/** Local repair metadata only. It never contains raw field text or an env key/value. */
export type AgentCatalogRepairIssue = {
  field: 'identity' | 'baseAgent' | 'label' | 'commandOverride' | 'args' | 'env'
  reason:
    | 'empty'
    | 'bounds'
    | 'control_char'
    | 'unterminated_quote'
    | 'quoted_line_break'
    | 'shell_operator'
    | 'reserved_name'
    | 'prototype_key'
    | 'case_collision'
    | 'env_total_bounds'
    | 'duplicate_id'
    | 'identity_mismatch'
  envEntryIndex?: number
}

export type SyncedCustomTuiAgent =
  | (Omit<CustomTuiAgent, 'env'> & {
      status: 'ready'
      // Describes host launch capability; keys and values are never projected.
      envState: 'none' | 'available' | 'withheld'
      // Conservative remote UX hint; never identifies PATH or another env key.
      // 'launch-reported' means baseline stock detection CANNOT vouch for this
      // row (configured executable or host-applicable env) and NO preflight runs
      // anywhere: availability is only ever established by an actual launch on
      // the execution host, which reports its own failure. Clients must not gate
      // such rows on baseline detection — and must not treat the value as proof
      // the executable exists.
      availabilityCheck: 'baseline-detection' | 'launch-reported'
    })
  | {
      id: CustomTuiAgentId
      baseAgent: BuiltInTuiAgent
      // Null when the persisted label itself is unsafe; clients localize a generic fallback.
      label: string | null
      status: 'repair-required'
      // Invalid raw command/args/env never enter a remote projection.
      envState: 'none'
    }

export type AgentCatalogSnapshot = {
  version: 1
  revision: number
  defaultAgent: TuiAgent | 'auto' | 'blank' | null
  disabledAgents: TuiAgent[]
  customAgents: SyncedCustomTuiAgent[]
  deletedCustomAgents: DeletedCustomTuiAgent[]
  /** Set while the host's v1 migration is fail-closed behind a failed pinned
   *  backup: catalog/reference writes are read-only pending recovery ON THE
   *  HOST. Boolean only — the error text stays host-local, never on the wire. */
  migrationBlocked?: true
}

export type AgentProjectionStatus =
  | { status: 'ready'; bytes: number; maxBytes: typeof MAX_AGENT_CATALOG_PROJECTION_BYTES }
  | { status: 'too-large'; bytes: number; maxBytes: typeof MAX_AGENT_CATALOG_PROJECTION_BYTES }

export type LocalAgentCatalogStorageStatus =
  | { status: 'ready'; bytes: number; maxBytes: typeof MAX_LOCAL_AGENT_CATALOG_BYTES }
  | { status: 'too-large'; bytes: number; maxBytes: typeof MAX_LOCAL_AGENT_CATALOG_BYTES }

export type LocalCustomTuiAgent =
  | {
      status: 'ready'
      definition: Omit<CustomTuiAgent, 'env'>
      envSummary: { entryCount: number; bytes: number }
      availabilityReason: 'baseline-stock' | 'configured-executable' | 'custom-path'
    }
  | {
      status: 'repair-required'
      // Present only when each value is independently canonical and safe to display/address.
      id?: CustomTuiAgentId
      baseAgent?: BuiltInTuiAgent
      label: string | null
      // Opaque, local-only, and valid only with this snapshot revision.
      repairToken: string
      issues: AgentCatalogRepairIssue[]
      rawBytes: number
      draftAvailability: 'available' | 'too-large'
    }

// Local Electron preload IPC only; never registered as a runtime RPC result.
export type LocalAgentCatalogSnapshot = Omit<AgentCatalogSnapshot, 'customAgents'> & {
  customAgents: LocalCustomTuiAgent[]
  repairIssues: AgentCatalogRepairIssue[]
  projection: AgentProjectionStatus
  localStorage: LocalAgentCatalogStorageStatus
  // Present while the pinned pre-v1 backup is failing and all catalog/reference
  // writes are fail-closed; lets Settings surface the block on load, not only
  // after a rejected mutation.
  migrationBlockedError?: string
  // Present while a newer build's schema stamp makes authoring read-only. Unlike
  // migrationBlockedError there is nothing to retry, so Settings must not offer it.
  schemaTooNew?: AgentCatalogSchemaTooNew
}

export const MAX_LOCAL_AGENT_DRAFT_BYTES = 1_048_576

export type CustomAgentEditableFields = {
  label: string
  commandOverride: string | null
  args: string
  env: Record<string, string>
  syncEnv: boolean
}

export type CustomAgentDraft = CustomAgentEditableFields

export type BuiltInAgentEditableFields = {
  commandOverride: string | null
  args: string
  env: Record<string, string>
}

export type LocalCustomAgentDraftResult =
  | {
      status: 'ready'
      revision: number
      draft: CustomAgentEditableFields
    }
  | {
      status: 'too-large'
      revision: number
      bytes: number
      maxBytes: typeof MAX_LOCAL_AGENT_DRAFT_BYTES
    }

export type AgentCatalogProjectionError = {
  version: 1
  revision: number
  code: 'agent_catalog_payload_too_large'
  maxBytes: typeof MAX_AGENT_CATALOG_PROJECTION_BYTES
}

export type AgentCatalogMutation =
  | { kind: 'create'; baseAgent: BuiltInTuiAgent; draft: CustomAgentDraft }
  | { kind: 'duplicate'; sourceAgent: TuiAgent; label: string }
  | { kind: 'update-custom'; id: CustomTuiAgentId; changes: CustomAgentEditableFields }
  | {
      kind: 'delete-custom'
      id: CustomTuiAgentId
      // Only applied when this id is the current default at expectedRevision; ignored otherwise.
      // `keep` (default) leaves the tombstoned id as the stored default for safe-fallback launches.
      // `base` rebinds to the proven base harness; `auto` stores Auto;
      // `clear` stores null so Settings prompts.
      onDefault?: 'keep' | 'base' | 'auto' | 'clear'
    }
  | { kind: 'set-enabled'; agent: TuiAgent; enabled: boolean }
  | { kind: 'set-default'; agent: TuiAgent | 'auto' | 'blank' }
  | {
      kind: 'repair-corrupt'
      repairToken: string
      action:
        | { kind: 'discard' }
        | { kind: 'replace'; baseAgent: BuiltInTuiAgent; draft: CustomAgentDraft }
    }
  | {
      kind: 'resolve-duplicate-id'
      duplicateId: CustomTuiAgentId
      // Host requires this to cover the exact current duplicate group once each.
      rows: readonly {
        repairToken: string
        action:
          | { kind: 'keep-for-existing-references'; repairedDraft: CustomAgentDraft }
          | { kind: 'discard' }
          | { kind: 'replace'; baseAgent: BuiltInTuiAgent; draft: CustomAgentDraft }
      }[]
    }
  | { kind: 'update-built-in'; agent: BuiltInTuiAgent; changes: BuiltInAgentEditableFields }

export type AgentCatalogMutationRequest = {
  expectedRevision: number
  mutation: AgentCatalogMutation
}

export type AgentCatalogMutationResult =
  | { ok: true; revision: number; snapshot: LocalAgentCatalogSnapshot }
  | {
      ok: false
      code:
        | 'catalog_revision_conflict'
        | 'duplicate_agent_label'
        | 'invalid_agent_field'
        | 'stale_agent_repair_token'
        | 'agent_catalog_local_payload_too_large'
        | 'agent_catalog_payload_too_large'
        // The durable settings write failed and was rolled back: nothing persisted.
        | 'agent_catalog_write_failed'
        // A newer build wrote this profile's catalog schema: read-only, no retry.
        | 'agent_catalog_schema_too_new'
      revision: number
      // Present on conflict so the editor can refresh while preserving the draft.
      snapshot?: LocalAgentCatalogSnapshot
      field?: 'label' | 'commandOverride' | 'args' | 'env'
      reason?:
        | 'empty'
        | 'bounds'
        | 'reserved_name'
        | 'prototype_key'
        | 'case_collision'
        | 'control_char'
        | 'unterminated_quote'
        | 'quoted_line_break'
        | 'shell_operator'
        | 'platform_ambiguous'
        | 'duplicate_id'
        | 'identity_mismatch'
        | 'env_total_bounds'
      envEntryIndex?: number
    }
