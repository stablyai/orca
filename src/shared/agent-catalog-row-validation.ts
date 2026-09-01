// Per-row validation for the persisted custom-agent catalog: classify each raw
// live record as valid / repair-required / corrupt, and normalize tombstones.
// Fail-closed — a row is only launchable when every field is independently valid.

import type {
  BuiltInTuiAgent,
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent
} from './types'
import { parseCustomTuiAgentId } from './custom-tui-agent-identity'
import {
  canonicalizeCommandOverride,
  normalizeAgentLabelText,
  utf8ByteLength,
  validateAgentArgs,
  validateAgentLabel,
  validateCommandOverride,
  validateCustomAgentEnv,
  type AgentFieldIssue
} from './custom-tui-agent-fields'

export type CorruptCatalogRow = {
  /** Present only when independently canonical and safe to display/address. */
  id?: CustomTuiAgentId
  baseAgent?: BuiltInTuiAgent
  /** Validated label or null when the persisted label itself is unsafe. */
  label: string | null
  issues: AgentFieldIssue[]
  /** UTF-8 JSON byte size of the raw physical record. */
  rawBytes: number
  /** Index of the physical record in the persisted live array. */
  physicalIndex: number
  /** The raw persisted record, retained for local repair only; never projected. */
  raw: unknown
}

export type LiveRowValidation =
  | { kind: 'valid'; definition: CustomTuiAgent }
  | { kind: 'repair-required'; row: CorruptCatalogRow }
  | { kind: 'corrupt'; row: CorruptCatalogRow }

export function measureRawBytes(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(value) ?? 'null')
  } catch {
    return 0
  }
}

export function normalizeTombstone(value: unknown): DeletedCustomTuiAgent | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const id = record.id
  const parsed = parseCustomTuiAgentId(id)
  // A tombstone is launch authority only when its id/base pair is canonical and agrees.
  if (!parsed || record.baseAgent !== parsed.baseAgent) {
    return null
  }
  const label = typeof record.label === 'string' ? record.label : ''
  const deletedAt =
    typeof record.deletedAt === 'number' && Number.isFinite(record.deletedAt) ? record.deletedAt : 0
  return {
    id: id as CustomTuiAgentId,
    baseAgent: parsed.baseAgent,
    label,
    deletedAt
  }
}

export function validateLiveRow(value: unknown, physicalIndex: number): LiveRowValidation {
  const rawBytes = measureRawBytes(value)
  if (typeof value !== 'object' || value === null) {
    return {
      kind: 'corrupt',
      row: {
        label: null,
        issues: [{ field: 'identity', reason: 'empty' }],
        rawBytes,
        physicalIndex,
        raw: value
      }
    }
  }
  const record = value as Record<string, unknown>
  const issues: AgentFieldIssue[] = []

  const parsed = parseCustomTuiAgentId(record.id)
  const idOk = parsed !== null
  if (!idOk) {
    issues.push({ field: 'identity', reason: 'empty' })
  }
  const baseOk = idOk && record.baseAgent === parsed.baseAgent
  if (idOk && !baseOk) {
    issues.push({ field: 'identity', reason: 'identity_mismatch' })
  }

  const labelIssue = validateAgentLabel(record.label)
  if (labelIssue) {
    issues.push(labelIssue)
  }
  const commandIssue = validateCommandOverride(record.commandOverride)
  if (commandIssue) {
    issues.push(commandIssue)
  }
  const argsIssue = validateAgentArgs(record.args ?? '')
  if (argsIssue) {
    issues.push(argsIssue)
  }
  issues.push(...validateCustomAgentEnv(record.env ?? {}))

  const safeLabel =
    typeof record.label === 'string' && !validateAgentLabel(record.label)
      ? normalizeAgentLabelText(record.label)
      : null

  if (!idOk || !baseOk) {
    return {
      kind: 'corrupt',
      row: {
        ...(idOk ? { id: record.id as CustomTuiAgentId, baseAgent: parsed.baseAgent } : {}),
        label: safeLabel,
        issues,
        rawBytes,
        physicalIndex,
        raw: value
      }
    }
  }

  if (issues.length > 0) {
    return {
      kind: 'repair-required',
      row: {
        id: record.id as CustomTuiAgentId,
        baseAgent: parsed.baseAgent,
        label: safeLabel,
        issues,
        rawBytes,
        physicalIndex,
        raw: value
      }
    }
  }

  const env: Record<string, string> = Object.create(null) as Record<string, string>
  // env may be absent on older rows; validation treats null/undefined as empty.
  for (const [key, envValue] of Object.entries((record.env ?? {}) as Record<string, string>)) {
    env[key] = envValue
  }
  const definition: CustomTuiAgent = {
    id: record.id as CustomTuiAgentId,
    baseAgent: parsed.baseAgent,
    label: normalizeAgentLabelText(record.label as string),
    ...(typeof record.commandOverride === 'string' && record.commandOverride.length > 0
      ? { commandOverride: canonicalizeCommandOverride(record.commandOverride) }
      : {}),
    args: typeof record.args === 'string' ? record.args : '',
    env,
    // Missing/invalid syncEnv normalizes to false (fail closed on env sharing).
    syncEnv: record.syncEnv === true
  }
  return { kind: 'valid', definition }
}
