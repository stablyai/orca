// Closed vocabularies for the audit TRANSPORT MODE — how an audit reached a
// model, as distinct from what it concluded.
//
// Separate from audited-code-audit-types.ts for the same reason that file is
// separate from audited-workflow-types.ts: widening a union here must break the
// renderer's exhaustive switches (lint:switch-exhaustiveness) rather than fall
// through to a default that would silently mislabel one mode as another.
//
// THE HONESTY INVARIANT THIS FILE EXISTS TO ENFORCE: a `byesu_no_tools` run is
// NOT a Codex audit. It has no shell, no filesystem, no MCP, no subprocess, and
// no network of its own — the model sees only the bounded bundle main assembled
// for it. Recording the mode on every run, and projecting it, is what stops the
// two from ever being presented as the same evidence.

/**
 * How an audit run reached its model.
 *
 * `codex_cli` is the Phase 5/7 path: a spawned `codex exec` with `--sandbox
 * read-only` that reads the worktree itself. `byesu_no_tools` is the HTTPS
 * adapter: no process, no tools, and only the bytes main chose to send.
 *
 * NULL in the database means `codex_cli` — see toAuditMode. A pre-existing run
 * predates this column and must never be relabeled as the weaker mode.
 */
export const AUDIT_MODES = ['codex_cli', 'byesu_no_tools'] as const
export type AuditMode = (typeof AUDIT_MODES)[number]

/** The display label. The parenthetical is load-bearing and never dropped. */
export const AUDIT_MODE_LABELS: Record<AuditMode, string> = {
  codex_cli: 'Codex CLI',
  byesu_no_tools: 'Byesu (no-tools)'
}

/**
 * Reads a persisted `audit_mode` column.
 *
 * NULL -> `codex_cli`, because every row written before this column existed came
 * from the CLI path. Defaulting the other way would retroactively downgrade real
 * Codex audits into no-tools ones, which is precisely the misrepresentation the
 * mode field exists to prevent.
 *
 * An UNRECOGNIZED value also resolves to `codex_cli`: it can only come from a
 * hand-edited database, and the conservative reading is the stronger claim's
 * label rather than silently minting a mode the vocabulary does not contain.
 */
export function toAuditMode(value: unknown): AuditMode {
  return value === 'byesu_no_tools' ? 'byesu_no_tools' : 'codex_cli'
}

/**
 * Transport and protocol failures for the no-tools adapter.
 *
 * DELIBERATELY DISJOINT from the verdict vocabulary. None of these is a
 * judgment about the work — every one means the audit did not produce a usable
 * opinion, so none of them can ever coexist with an `approved` verdict.
 */
export const NO_TOOLS_REASON_CODES = [
  // --- Transport ---------------------------------------------------------
  // 401/403. The stored key was rejected. NOT retryable by button: a retry with
  // the same key reproduces it, and the user must fix the credential first.
  'api_unauthorized',
  // 429, or a 5xx that names a quota. Retryable — the condition is temporal.
  'api_rate_limited',
  // 5xx, DNS failure, TLS failure, socket error. Retryable.
  'api_unavailable',
  // The whole request exceeded NO_TOOLS_REQUEST_TIMEOUT_MS. Retryable.
  'api_timeout',
  // --- Protocol ----------------------------------------------------------
  // A 2xx whose body was not the JSON shape the wire API promises. Distinct
  // from `verdict_unparseable`, which means the ENVELOPE parsed and the model's
  // own message did not.
  'response_malformed',
  // The provider reported the input or output exceeded the model's context. Not
  // retryable: the same bundle reproduces it.
  'context_limit_exceeded',
  // --- Bundle assembly (nothing was ever sent) ---------------------------
  // The assembled bundle exceeded a declared cap. Fails BEFORE dispatch.
  'bundle_too_large',
  // Redaction could not be applied to a fragment, so it was never sent. Fails
  // closed: an un-redactable fragment is dropped from the audit, not shipped.
  'redaction_failed',
  // --- Mediated retrieval ------------------------------------------------
  // The model asked for a path outside the permitted scope, an absolute path, a
  // traversal, or a malformed request. ANY invalid request blocks the audit
  // rather than being skipped, so a probing model cannot iterate toward a leak.
  'context_request_invalid',
  // The follow-up turn or byte budget was exhausted before a verdict.
  'context_budget_exhausted'
] as const
export type NoToolsReasonCode = (typeof NO_TOOLS_REASON_CODES)[number]

/**
 * Which no-tools failures a Retry button may re-attempt.
 *
 * Absent by design: `api_unauthorized` (needs a new key), `context_limit_exceeded`
 * and `bundle_too_large` (the same bundle reproduces them), `response_malformed`
 * (a deterministic provider defect, not a transient one), and every mediated-
 * retrieval code (a model that asked out of scope will ask again).
 */
export const RETRYABLE_NO_TOOLS_REASON_CODES: readonly NoToolsReasonCode[] = [
  'api_rate_limited',
  'api_unavailable',
  'api_timeout'
]

export function isRetryableNoToolsReasonCode(code: NoToolsReasonCode): boolean {
  return RETRYABLE_NO_TOOLS_REASON_CODES.includes(code)
}

/**
 * Whether the model may request additional files mid-audit.
 *
 * FALSE FOR THE FIRST RELEASE. A CODE-OWNED DISABLED CAPABILITY in the same
 * sense as AUDITED_CODEX_CREDENTIAL_DELIVERY_ENABLED: it is an ordinary source
 * constant, not a build-time boundary and not a feature flag. Its value is
 * procedural — no IPC, settings, or environment variable reads it, so enabling
 * retrieval is necessarily a reviewed code change.
 *
 * While this is false, a `needFiles` reply is treated as a protocol violation
 * that ENDS the audit. The validation and scope-checking code remains present
 * and tested so that enabling the capability is a one-line change plus a
 * prompt update, reviewed together — but it is unreachable in production.
 *
 * DEFENCE IN DEPTH: this is checked INDEPENDENTLY of maxFollowUpTurns, so
 * flipping either one alone cannot dispatch a follow-up turn.
 */
export const MEDIATED_RETRIEVAL_ENABLED = false

/**
 * Every bound the adapter enforces, in one object so a limit cannot be raised in
 * one module while another still assumes the old value.
 *
 * These are MAIN-PROCESS CONSTANTS. Nothing renderer-supplied, settings-backed,
 * or environment-read may change them — a configurable byte cap would turn a
 * preference into a data-exfiltration dial.
 */
export const NO_TOOLS_LIMITS = {
  /** Total assembled bundle, including every follow-up turn's additions. */
  maxBundleBytes: 256 * 1024,
  /** Files inlined in the initial bundle. */
  maxBundleFiles: 40,
  /** Any single file's contribution, before redaction. */
  maxFileBytes: 32 * 1024,
  /** The diff/stat section specifically, which is the easiest to run away. */
  maxDiffBytes: 96 * 1024,
  /** Cap on the model's own reply, so a runaway response is bounded. */
  maxOutputTokens: 4096,
  /**
   * Mediated-retrieval follow-up turns. ZERO — retrieval is DISABLED for the
   * first release.
   *
   * Every follow-up turn lets model output select which bytes leave the
   * machine. That surface is bounded and scope-validated, but the first release
   * ships without it entirely: the adapter operates only on the bundle main
   * already prepared. See MEDIATED_RETRIEVAL_ENABLED — this value and that flag
   * are checked independently, so neither alone can re-enable the path.
   */
  maxFollowUpTurns: 0,
  /** Files one `needFiles` request may name. */
  maxRequestedFiles: 10,
  /** Whole-request wall clock, including follow-up turns. */
  requestTimeoutMs: 120_000
} as const
