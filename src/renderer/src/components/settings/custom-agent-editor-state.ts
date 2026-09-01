// Pure form-state model for the custom-agent authoring dialog (new/edit/duplicate).
// It reuses the shared field validators and the v1 args tokenizer so the client
// pre-check matches the host's authoritative validation exactly, and builds the
// revision-checked catalog mutation the dialog submits. It holds no React state.

import type {
  BuiltInTuiAgent,
  CustomTuiAgentId,
  GlobalSettings,
  TuiAgent
} from '../../../../shared/types'
import type {
  AgentCatalogMutation,
  AgentCatalogMutationResult,
  BuiltInAgentEditableFields,
  CustomAgentDraft,
  CustomAgentEditableFields
} from '../../../../shared/agent-catalog-snapshot'
import {
  canonicalizeCommandOverride,
  normalizeAgentLabelText,
  validateAgentArgs,
  validateAgentLabel,
  validateBuiltInArgs,
  validateBuiltInCommandOverride,
  validateCommandOverride,
  validateCustomAgentEnv,
  type AgentFieldIssue
} from '../../../../shared/custom-tui-agent-fields'
import {
  canonicalizeAgentArgsLineEndings,
  tokenizeAgentArgsTemplate,
  type AgentArgsTokenizeResult
} from '../../../../shared/agent-args-tokenizer'

export type CustomAgentEditorMode =
  | { kind: 'new' }
  | { kind: 'edit'; id: CustomTuiAgentId }
  | { kind: 'duplicate'; sourceAgent: TuiAgent }
  // Editing a shipped built-in's command/args/env overrides (no label, base, or
  // paired-env sharing); persisted through the update-built-in mutation.
  | { kind: 'built-in-launch'; agent: BuiltInTuiAgent }
  // Repairing a corrupt custom row that still has a canonical id + base: the
  // editor seeds from the repair token and submits update-custom (plan §186/§972).
  | { kind: 'repair-edit'; id: CustomTuiAgentId; repairToken: string; baseAgent: BuiltInTuiAgent }
  // Replacing a non-addressable corrupt row with a freshly authored agent: the
  // user picks a base and a new id is minted through repair-corrupt/replace.
  | { kind: 'repair-replace'; repairToken: string }

/** True when the base harness is user-selectable (a fresh agent). Edit and
 *  repair-edit keep the persisted base immutable and render it read-only. */
export function isBaseSelectableMode(mode: CustomAgentEditorMode): boolean {
  return mode.kind === 'new' || mode.kind === 'repair-replace'
}

/** One environment entry in the editor. `rowId` is an ephemeral React list key,
 *  never persisted; `revealed` toggles the value input between hidden and shown. */
export type CustomAgentEnvRow = {
  rowId: string
  key: string
  value: string
  revealed: boolean
}

export type CustomAgentEditorDraft = {
  baseAgent: BuiltInTuiAgent
  label: string
  commandOverride: string
  args: string
  envRows: CustomAgentEnvRow[]
  syncEnv: boolean
}

/** Where a rejected mutation should move focus, so the dialog surfaces the error
 *  on the offending control without ever reading the secret-safe field value. */
export type CustomAgentMutationFocus = {
  field: 'label' | 'commandOverride' | 'args' | 'env'
  envEntryIndex?: number
}

// Monotonic ephemeral key source for env rows. Stable across a render so React
// keeps focus on the row the user is editing; reset only matters for tests.
let envRowSequence = 0

export function nextEnvRowId(): string {
  envRowSequence += 1
  return `env-${envRowSequence}`
}

export function createEnvRow(seed: { key?: string; value?: string } = {}): CustomAgentEnvRow {
  return {
    rowId: nextEnvRowId(),
    key: seed.key ?? '',
    value: seed.value ?? '',
    revealed: false
  }
}

export function emptyDraft(baseAgent: BuiltInTuiAgent): CustomAgentEditorDraft {
  return {
    baseAgent,
    label: '',
    commandOverride: '',
    args: '',
    // Start with one blank row so the value control is present without an add click.
    envRows: [createEnvRow()],
    syncEnv: false
  }
}

/** Seed the editor for a built-in from its current persisted launch overrides.
 *  There is no getLocalDraft locator for built-ins, so the settings maps are the
 *  source; missing entries mean "no override" (blank fields showing defaults). */
export function builtInDraftFromSettings(
  agent: BuiltInTuiAgent,
  settings:
    | Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'>
    | null
    | undefined
): CustomAgentEditorDraft {
  const env = settings?.agentDefaultEnv?.[agent] ?? {}
  const envRows = Object.entries(env).map(([key, value]) => createEnvRow({ key, value }))
  return {
    baseAgent: agent,
    label: '',
    commandOverride: settings?.agentCmdOverrides?.[agent] ?? '',
    args: settings?.agentDefaultArgs?.[agent] ?? '',
    envRows: envRows.length > 0 ? envRows : [createEnvRow()],
    syncEnv: false
  }
}

/** Canonical update-built-in payload: an empty command stores no override; args
 *  stay raw legacy text (tokenized per target shell at launch, not v1-grammar). */
export function toBuiltInAgentChanges(draft: CustomAgentEditorDraft): BuiltInAgentEditableFields {
  const trimmedCommand = draft.commandOverride.trim()
  return {
    commandOverride: trimmedCommand === '' ? null : trimmedCommand,
    args: draft.args,
    env: serializeEnvRows(draft.envRows)
  }
}

export function draftFromEditableFields(
  fields: CustomAgentEditableFields,
  baseAgent: BuiltInTuiAgent
): CustomAgentEditorDraft {
  const envRows = Object.entries(fields.env).map(([key, value]) => createEnvRow({ key, value }))
  return {
    baseAgent,
    label: fields.label,
    commandOverride: fields.commandOverride ?? '',
    args: fields.args,
    // Preserve a value control even when the stored definition has no env.
    envRows: envRows.length > 0 ? envRows : [createEnvRow()],
    syncEnv: fields.syncEnv
  }
}

/** Ordered `Record` for the mutation payload. A fully blank row is dropped;
 *  a row with a blank key but a value is retained so validation flags it rather
 *  than silently discarding the user's input. Case-insensitive collisions are
 *  left for the shared validator to report against the assembled record. */
export function serializeEnvRows(rows: readonly CustomAgentEnvRow[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const row of rows) {
    if (row.key === '' && row.value === '') {
      continue
    }
    env[row.key] = row.value
  }
  return env
}

/** Exact-duplicate keys collapse to one `Record` entry in `serializeEnvRows`, so
 *  the shared validator never sees them; flag the overwriting row here instead of
 *  silently dropping the user's earlier value. This includes a repeated *blank*
 *  key (two blank-key rows with different values also collapse to one entry).
 *  `envEntryIndex` MUST be the serialized position (fully-blank rows dropped) that
 *  CustomAgentEnvRowsEditor renders per-row errors against — a raw array index
 *  diverges the moment a blank row precedes a duplicate, so the error would block
 *  Save while rendering nowhere. */
export function duplicateEnvKeyIssues(rows: readonly CustomAgentEnvRow[]): AgentFieldIssue[] {
  const seen = new Set<string>()
  const issues: AgentFieldIssue[] = []
  let serializedIndex = 0
  for (const row of rows) {
    // Mirror serializeEnvRows: only a fully-blank row is dropped and carries no
    // serialized index; every other row advances the position the editor uses.
    if (row.key === '' && row.value === '') {
      continue
    }
    if (seen.has(row.key)) {
      issues.push({ field: 'env', reason: 'case_collision', envEntryIndex: serializedIndex })
    } else {
      seen.add(row.key)
    }
    serializedIndex += 1
  }
  return issues
}

/** The canonical mutation payload: label normalized, an empty override stored as
 *  no override (`null`), args line-endings canonicalized on save, env assembled. */
export function toCustomAgentDraft(draft: CustomAgentEditorDraft): CustomAgentDraft {
  const trimmedCommand = draft.commandOverride.trim()
  return {
    label: normalizeAgentLabelText(draft.label),
    commandOverride:
      trimmedCommand === '' ? null : canonicalizeCommandOverride(draft.commandOverride),
    args: canonicalizeAgentArgsLineEndings(draft.args),
    env: serializeEnvRows(draft.envRows),
    syncEnv: draft.syncEnv
  }
}

export function buildMutation(
  mode: CustomAgentEditorMode,
  draft: CustomAgentEditorDraft
): AgentCatalogMutation {
  switch (mode.kind) {
    case 'new':
      return { kind: 'create', baseAgent: draft.baseAgent, draft: toCustomAgentDraft(draft) }
    case 'edit':
      return { kind: 'update-custom', id: mode.id, changes: toCustomAgentDraft(draft) }
    case 'duplicate':
      // The host copies the source config; the dialog only names the new agent.
      return {
        kind: 'duplicate',
        sourceAgent: mode.sourceAgent,
        label: normalizeAgentLabelText(draft.label)
      }
    case 'built-in-launch':
      return { kind: 'update-built-in', agent: mode.agent, changes: toBuiltInAgentChanges(draft) }
    case 'repair-edit':
      // A canonical id/base row is repaired in place through the normal update.
      return { kind: 'update-custom', id: mode.id, changes: toCustomAgentDraft(draft) }
    case 'repair-replace':
      // The old row is dropped and a fresh id minted; references are not rebound.
      return {
        kind: 'repair-corrupt',
        repairToken: mode.repairToken,
        action: { kind: 'replace', baseAgent: draft.baseAgent, draft: toCustomAgentDraft(draft) }
      }
  }
}

/** Client-side pre-validation mirroring the shared validators. Label uniqueness
 *  is host-authoritative (it needs the full catalog) so it is not checked here.
 *  Duplicate mode submits only the label, so only the label is validated. */
export function validateDraftLocally(
  mode: CustomAgentEditorMode,
  draft: CustomAgentEditorDraft
): AgentFieldIssue[] {
  if (mode.kind === 'built-in-launch') {
    // Built-ins have no label; command is permissive (multi-token wrappers), args
    // are legacy length-only. Env keeps the shared safety validators.
    const builtInIssues: AgentFieldIssue[] = []
    const trimmedCommand = draft.commandOverride.trim()
    const commandIssue = validateBuiltInCommandOverride(
      trimmedCommand === '' ? null : trimmedCommand
    )
    if (commandIssue) {
      builtInIssues.push(commandIssue)
    }
    const builtInArgsIssue = validateBuiltInArgs(draft.args)
    if (builtInArgsIssue) {
      builtInIssues.push(builtInArgsIssue)
    }
    builtInIssues.push(...validateCustomAgentEnv(serializeEnvRows(draft.envRows)))
    builtInIssues.push(...duplicateEnvKeyIssues(draft.envRows))
    return builtInIssues
  }
  const labelIssue = validateAgentLabel(draft.label)
  if (mode.kind === 'duplicate') {
    return labelIssue ? [labelIssue] : []
  }
  const issues: AgentFieldIssue[] = []
  if (labelIssue) {
    issues.push(labelIssue)
  }
  const commandIssue = validateCommandOverride(
    draft.commandOverride.trim() === '' ? null : draft.commandOverride
  )
  if (commandIssue) {
    issues.push(commandIssue)
  }
  const argsIssue = validateAgentArgs(draft.args)
  if (argsIssue) {
    issues.push(argsIssue)
  }
  issues.push(...validateCustomAgentEnv(serializeEnvRows(draft.envRows)))
  issues.push(...duplicateEnvKeyIssues(draft.envRows))
  return issues
}

/** Live token preview for the Arguments field. A quoted line break or unbalanced
 *  quote reports the failing offset so the dialog can explain it in place. */
export function previewArgsTokens(args: string): AgentArgsTokenizeResult {
  return tokenizeAgentArgsTemplate(args)
}

/** Focus target for a rejected mutation. A revision conflict returns null: the
 *  dialog reloads the snapshot and keeps the draft rather than blaming a field.
 *  Payload-size failures also return null (a form-level banner, not one field). */
export function resolveMutationErrorFocus(
  result: Extract<AgentCatalogMutationResult, { ok: false }>
): CustomAgentMutationFocus | null {
  switch (result.code) {
    case 'duplicate_agent_label':
      return { field: 'label' }
    case 'invalid_agent_field':
      if (!result.field) {
        return null
      }
      return result.envEntryIndex === undefined
        ? { field: result.field }
        : { field: result.field, envEntryIndex: result.envEntryIndex }
    // None of these blame a field — including a failed durable write and a
    // read-only profile, where the draft stands and simply isn't saved.
    case 'catalog_revision_conflict':
    case 'agent_catalog_local_payload_too_large':
    case 'agent_catalog_payload_too_large':
    case 'stale_agent_repair_token':
    case 'agent_catalog_write_failed':
    case 'agent_catalog_schema_too_new':
      return null
  }
}
