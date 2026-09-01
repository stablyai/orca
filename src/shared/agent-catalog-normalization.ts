// Normalized agent catalog: one immutable, fail-closed lookup built from persisted
// settings arrays. Invalid rows become repair/corrupt records — no field is
// dropped, truncated, or rewritten to make a row launchable. Per-row validation
// lives in the re-exported row-validation sibling.

import type { CustomTuiAgent, CustomTuiAgentId, DeletedCustomTuiAgent, TuiAgent } from './types'
import { isBuiltInTuiAgent } from './tui-agent-config'
import { isCustomTuiAgentId } from './custom-tui-agent-identity'
import {
  measureRawBytes,
  normalizeTombstone,
  validateLiveRow,
  type CorruptCatalogRow,
  type LiveRowValidation
} from './agent-catalog-row-validation'

export type { CorruptCatalogRow } from './agent-catalog-row-validation'

export type AgentCatalog = {
  /** Live, fully valid custom agents in persisted creation order. */
  readonly liveCustomAgents: readonly CustomTuiAgent[]
  readonly liveById: ReadonlyMap<CustomTuiAgentId, CustomTuiAgent>
  /** Live rows whose id/base are valid and unique but another field needs repair.
   *  Addressable and visible, never launchable. */
  readonly repairRequiredById: ReadonlyMap<CustomTuiAgentId, CorruptCatalogRow>
  /** Rows that cannot be addressed unambiguously by id (malformed or duplicate). */
  readonly corruptRows: readonly CorruptCatalogRow[]
  readonly tombstonesById: ReadonlyMap<CustomTuiAgentId, DeletedCustomTuiAgent>
  readonly disabledAgents: ReadonlySet<TuiAgent>
  readonly defaultAgent: TuiAgent | 'auto' | 'blank' | null
}

export type NormalizedAgentCatalogInput = {
  customTuiAgents?: unknown
  deletedCustomTuiAgents?: unknown
  disabledTuiAgents?: unknown
  defaultTuiAgent?: unknown
}

export type NormalizeAgentCatalogResult = {
  catalog: AgentCatalog
  /** True when the default was repaired to null (unknown custom id with neither
   *  definition nor tombstone, or base-disabled default). */
  defaultRepairedToNull: boolean
}

/** Build one immutable lookup over persisted catalog state. Fail-closed, not lossy:
 *  invalid rows become repair/corrupt records — no field is dropped, truncated, or
 *  rewritten to make a row launchable. */
export function normalizeAgentCatalog(
  input: NormalizedAgentCatalogInput
): NormalizeAgentCatalogResult {
  const tombstonesById = new Map<CustomTuiAgentId, DeletedCustomTuiAgent>()
  if (Array.isArray(input.deletedCustomTuiAgents)) {
    for (const raw of input.deletedCustomTuiAgents) {
      const tombstone = normalizeTombstone(raw)
      if (tombstone && !tombstonesById.has(tombstone.id)) {
        tombstonesById.set(tombstone.id, tombstone)
      }
    }
  }

  const liveById = new Map<CustomTuiAgentId, CustomTuiAgent>()
  const liveCustomAgents: CustomTuiAgent[] = []
  const repairRequiredById = new Map<CustomTuiAgentId, CorruptCatalogRow>()
  const corruptRows: CorruptCatalogRow[] = []
  const validRowsById = new Map<CustomTuiAgentId, LiveRowValidation[]>()
  // Each row keeps its persisted array index: repair mutations splice the
  // persisted array by physicalIndex, so it must never be derived from how
  // many rows happened to classify as live/corrupt before this one.
  const rows: { row: LiveRowValidation; index: number }[] = []

  if (Array.isArray(input.customTuiAgents)) {
    input.customTuiAgents.forEach((raw, index) => {
      const row = validateLiveRow(raw, index)
      rows.push({ row, index })
      const id =
        row.kind === 'valid' ? row.definition.id : row.row.id !== undefined ? row.row.id : null
      if (id !== null) {
        const group = validRowsById.get(id)
        if (group) {
          group.push(row)
        } else {
          validRowsById.set(id, [row])
        }
      }
    })
  }

  // Duplicate live ids quarantine the whole group: removing one duplicate must
  // never silently make another authoritative (repair is one atomic group choice).
  const duplicateIds = new Set<CustomTuiAgentId>()
  for (const [id, group] of validRowsById) {
    if (group.length > 1) {
      duplicateIds.add(id)
    }
  }

  for (const { row, index } of rows) {
    if (row.kind === 'valid') {
      const id = row.definition.id
      if (duplicateIds.has(id)) {
        corruptRows.push({
          id,
          baseAgent: row.definition.baseAgent,
          label: row.definition.label,
          issues: [{ field: 'identity', reason: 'duplicate_id' }],
          rawBytes: measureRawBytes(row.definition),
          physicalIndex: index,
          raw: row.definition
        })
        continue
      }
      // Ids are never reused: a same-id tombstone wins so deletion cannot
      // resurrect after corrupted/legacy merges.
      if (tombstonesById.has(id)) {
        continue
      }
      liveById.set(id, row.definition)
      liveCustomAgents.push(row.definition)
      continue
    }
    if (row.kind === 'repair-required') {
      const id = row.row.id
      if (id !== undefined && duplicateIds.has(id)) {
        corruptRows.push({
          ...row.row,
          issues: [...row.row.issues, { field: 'identity', reason: 'duplicate_id' }]
        })
        continue
      }
      if (id !== undefined && tombstonesById.has(id)) {
        continue
      }
      if (id !== undefined) {
        repairRequiredById.set(id, row.row)
      } else {
        corruptRows.push(row.row)
      }
      continue
    }
    // A corrupt row (e.g. base mismatch) that still carries a duplicated id must
    // join the duplicate group, or resolve-duplicate-id can never cover it and
    // the group repair loops forever.
    const corruptId = row.row.id
    if (
      corruptId !== undefined &&
      duplicateIds.has(corruptId) &&
      !row.row.issues.some((issue) => issue.reason === 'duplicate_id')
    ) {
      corruptRows.push({
        ...row.row,
        issues: [...row.row.issues, { field: 'identity', reason: 'duplicate_id' }]
      })
      continue
    }
    corruptRows.push(row.row)
  }

  const disabledAgents = new Set<TuiAgent>()
  if (Array.isArray(input.disabledTuiAgents)) {
    for (const item of input.disabledTuiAgents) {
      if (isBuiltInTuiAgent(item)) {
        disabledAgents.add(item)
        continue
      }
      // Only known built-ins or live custom ids belong in the disabled list;
      // repair-required rows keep their disabled state so repair cannot enable.
      if (isCustomTuiAgentId(item) && (liveById.has(item) || repairRequiredById.has(item))) {
        disabledAgents.add(item)
      }
    }
  }

  let defaultAgent: TuiAgent | 'auto' | 'blank' | null = null
  let defaultRepairedToNull = false
  const rawDefault = input.defaultTuiAgent
  if (rawDefault === 'auto' || rawDefault === 'blank' || rawDefault === null) {
    defaultAgent = rawDefault as 'auto' | 'blank' | null
  } else if (isBuiltInTuiAgent(rawDefault)) {
    defaultAgent = rawDefault
  } else if (isCustomTuiAgentId(rawDefault)) {
    const live = liveById.get(rawDefault) ?? null
    const repair = repairRequiredById.get(rawDefault) ?? null
    const tombstone = tombstonesById.get(rawDefault) ?? null
    const provenBase = live?.baseAgent ?? repair?.baseAgent ?? tombstone?.baseAgent ?? null
    if (provenBase === null) {
      // Unknown custom id with neither definition nor tombstone: id syntax alone
      // grants no authority, so the default repairs to null (needs attention).
      defaultAgent = null
      defaultRepairedToNull = true
    } else if (disabledAgents.has(provenBase)) {
      // Disabling the base repairs a base/derivative default to null because no
      // fallback is launchable.
      defaultAgent = null
      defaultRepairedToNull = true
    } else {
      // A live disabled/tombstoned custom default remains a validated stored
      // reference for attended safe fallback.
      defaultAgent = rawDefault
    }
  } else {
    defaultAgent = null
    if (rawDefault !== undefined) {
      defaultRepairedToNull = true
    }
  }
  if (isBuiltInTuiAgent(defaultAgent) && disabledAgents.has(defaultAgent)) {
    // Built-in default whose base is disabled: same repair rule as derivatives.
    defaultAgent = null
    defaultRepairedToNull = true
  }

  return {
    catalog: {
      liveCustomAgents,
      liveById,
      repairRequiredById,
      corruptRows,
      tombstonesById,
      disabledAgents,
      defaultAgent
    },
    defaultRepairedToNull
  }
}
