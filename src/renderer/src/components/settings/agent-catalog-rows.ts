// Render-time derivation of the Settings management catalog: one ordered,
// per-revision pass that turns the local snapshot + detection + settings into
// quiet rows with effective status and a bounded search summary. Pure and
// node-free so it unit-tests without a DOM and never mirrors state via effects.

import type {
  BuiltInTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  GlobalSettings,
  TuiAgent
} from '../../../../shared/types'
import type {
  AgentCatalogRepairIssue,
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../../shared/agent-catalog-snapshot'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import {
  agentSearchSummaryMatches,
  buildAgentSearchSummary,
  normalizeAgentSearchQuery
} from '../../../../shared/agent-search-query'

/** Effective status shown as a single quiet badge (plan §971). Desktop-local
 *  never surfaces `launch-reported`; that reason is withheld to paired clients. */
export type AgentCatalogRowStatus =
  | 'enabled'
  | 'disabled'
  | 'base-disabled'
  | 'not-installed'
  | 'custom-executable'
  | 'custom-path'
  | 'repair-required'

export type RepairRoute = 'edit' | 'duplicate' | 'discard-replace'

type AgentCatalogConfiguredRow = {
  label: string
  commandSummary: string
  status: AgentCatalogRowStatus
  enabled: boolean
  isDefault: boolean
  searchSummary: string
}

export type AgentCatalogRow =
  | ({
      kind: 'built-in'
      id: BuiltInTuiAgent
      baseAgent: BuiltInTuiAgent
    } & AgentCatalogConfiguredRow)
  | ({
      kind: 'custom'
      id: CustomTuiAgentId
      baseAgent: BuiltInTuiAgent
    } & AgentCatalogConfiguredRow)
  | {
      kind: 'repair'
      // Repair rows are addressed by opaque repair token, never by a (possibly
      // corrupt) id, and can only ever open their repair form.
      repairToken: string
      // Present only when the value is independently canonical/safe (snapshot rule).
      id?: CustomTuiAgentId
      baseAgent?: BuiltInTuiAgent
      label: string | null
      issues: AgentCatalogRepairIssue[]
      draftAvailability: 'available' | 'too-large'
      // Which repair form the Repair button opens (plan §977): `edit` = valid,
      // addressable id/base corrected in the editor via update-custom; `duplicate`
      // = one of several rows sharing an id, resolved atomically as a group;
      // `discard-replace` = malformed/non-addressable, only discard or replace-as-new.
      route: RepairRoute
      searchSummary: string
    }
  | {
      kind: 'deleted'
      id: CustomTuiAgentId
      baseAgent: BuiltInTuiAgent
      label: string
      referenceCount: number | null
      searchSummary: string
    }

export type AgentCatalogRowsInput = {
  snapshot: LocalAgentCatalogSnapshot
  settings: Pick<GlobalSettings, 'agentCmdOverrides'>
  /** PATH-detected base ids, or null while detection is in flight (no availability claim). */
  detectedIds: ReadonlySet<string> | null
  /** Live reference counts for deleted tombstones, when the reference summary is loaded. */
  deletedReferenceCounts?: ReadonlyMap<CustomTuiAgentId, number>
}

function baseDisplayName(base: BuiltInTuiAgent): string {
  return TUI_AGENT_DISPLAY_NAMES[base]
}

function builtInStatus(
  base: BuiltInTuiAgent,
  entry: AgentCatalogEntry | undefined,
  input: AgentCatalogRowsInput,
  disabled: ReadonlySet<TuiAgent>
): { status: AgentCatalogRowStatus; commandSummary: string } {
  const override = input.settings.agentCmdOverrides?.[base]
  const stockCommand = entry?.cmd ?? base
  if (disabled.has(base)) {
    return { status: 'disabled', commandSummary: override ?? stockCommand }
  }
  // A configured executable cannot be verified by stock PATH detection, so it
  // reads as Custom executable rather than a false "not installed".
  if (override) {
    return { status: 'custom-executable', commandSummary: override }
  }
  if (input.detectedIds !== null && !input.detectedIds.has(base)) {
    return { status: 'not-installed', commandSummary: stockCommand }
  }
  return { status: 'enabled', commandSummary: stockCommand }
}

function readyCustomStatus(
  agent: Extract<LocalCustomTuiAgent, { status: 'ready' }>,
  input: AgentCatalogRowsInput,
  disabled: ReadonlySet<TuiAgent>
): AgentCatalogRowStatus {
  const base = agent.definition.baseAgent
  if (disabled.has(agent.definition.id)) {
    return 'disabled'
  }
  if (disabled.has(base)) {
    return 'base-disabled'
  }
  switch (agent.availabilityReason) {
    case 'configured-executable':
      return 'custom-executable'
    case 'custom-path':
      return 'custom-path'
    case 'baseline-stock':
      if (input.detectedIds !== null && !input.detectedIds.has(base)) {
        return 'not-installed'
      }
      return 'enabled'
  }
}

function customCommandSummary(
  agent: Extract<LocalCustomTuiAgent, { status: 'ready' }>,
  entry: AgentCatalogEntry | undefined
): string {
  const prefix = agent.definition.commandOverride ?? entry?.cmd ?? agent.definition.baseAgent
  const args = agent.definition.args.trim()
  return args ? `${prefix} ${args}` : prefix
}

function buildReadyCustomRow(
  agent: Extract<LocalCustomTuiAgent, { status: 'ready' }>,
  entry: AgentCatalogEntry | undefined,
  input: AgentCatalogRowsInput,
  disabled: ReadonlySet<TuiAgent>,
  defaultAgent: TuiAgent | 'auto' | 'blank' | null
): AgentCatalogRow {
  const commandSummary = customCommandSummary(agent, entry)
  const label = agent.definition.label
  return {
    kind: 'custom',
    id: agent.definition.id,
    baseAgent: agent.definition.baseAgent,
    label,
    commandSummary,
    status: readyCustomStatus(agent, input, disabled),
    enabled: !disabled.has(agent.definition.id),
    isDefault: defaultAgent === agent.definition.id,
    searchSummary: buildAgentSearchSummary({
      label,
      baseName: baseDisplayName(agent.definition.baseAgent),
      commandSummary
    })
  }
}

// Route the Repair button (plan §977). A duplicate-id row resolves as a group;
// a row with a canonical id + base is corrected in the editor; anything else is
// non-addressable and may only be discarded or replaced as a new agent.
function deriveRepairRoute(
  agent: Extract<LocalCustomTuiAgent, { status: 'repair-required' }>
): RepairRoute {
  if (agent.issues.some((issue) => issue.reason === 'duplicate_id')) {
    return 'duplicate'
  }
  if (agent.id && agent.baseAgent) {
    return 'edit'
  }
  return 'discard-replace'
}

function buildRepairRow(
  agent: Extract<LocalCustomTuiAgent, { status: 'repair-required' }>
): AgentCatalogRow {
  return {
    kind: 'repair',
    repairToken: agent.repairToken,
    id: agent.id,
    baseAgent: agent.baseAgent,
    label: agent.label,
    issues: agent.issues,
    draftAvailability: agent.draftAvailability,
    route: deriveRepairRoute(agent),
    searchSummary: buildAgentSearchSummary({
      label: agent.label ?? '',
      baseName: agent.baseAgent ? baseDisplayName(agent.baseAgent) : ''
    })
  }
}

function buildDeletedRow(
  tombstone: DeletedCustomTuiAgent,
  input: AgentCatalogRowsInput
): AgentCatalogRow {
  const count = input.deletedReferenceCounts?.get(tombstone.id)
  return {
    kind: 'deleted',
    id: tombstone.id,
    baseAgent: tombstone.baseAgent,
    label: tombstone.label,
    referenceCount: count ?? null,
    searchSummary: buildAgentSearchSummary({
      label: tombstone.label,
      baseName: baseDisplayName(tombstone.baseAgent)
    })
  }
}

function isReady(
  agent: LocalCustomTuiAgent
): agent is Extract<LocalCustomTuiAgent, { status: 'ready' }> {
  return agent.status === 'ready'
}

/**
 * Order: built-ins in canonical product order, each base's ready customs
 * (creation order), then that base's repair rows and deleted tombstones,
 * finally any malformed repair rows with no resolvable base. Enabling, editing,
 * or searching never reshuffles equal rows because grouping keys off the base
 * id and the snapshot's stable custom order, never labels or array churn.
 */
export function deriveAgentCatalogRows(input: AgentCatalogRowsInput): AgentCatalogRow[] {
  const { snapshot } = input
  const disabled = new Set<TuiAgent>(snapshot.disabledAgents)
  const catalog = getAgentCatalog()
  const entryByBase = new Map<BuiltInTuiAgent, AgentCatalogEntry>(
    catalog.map((entry) => [entry.id as BuiltInTuiAgent, entry])
  )

  const readyByBase = new Map<BuiltInTuiAgent, AgentCatalogRow[]>()
  const repairByBase = new Map<BuiltInTuiAgent, AgentCatalogRow[]>()
  const orphanRepairs: AgentCatalogRow[] = []
  for (const agent of snapshot.customAgents) {
    if (isReady(agent)) {
      const row = buildReadyCustomRow(
        agent,
        entryByBase.get(agent.definition.baseAgent),
        input,
        disabled,
        snapshot.defaultAgent
      )
      const bucket = readyByBase.get(agent.definition.baseAgent) ?? []
      bucket.push(row)
      readyByBase.set(agent.definition.baseAgent, bucket)
    } else if (agent.baseAgent) {
      const row = buildRepairRow(agent)
      const bucket = repairByBase.get(agent.baseAgent) ?? []
      bucket.push(row)
      repairByBase.set(agent.baseAgent, bucket)
    } else {
      orphanRepairs.push(buildRepairRow(agent))
    }
  }

  const deletedByBase = new Map<BuiltInTuiAgent, AgentCatalogRow[]>()
  for (const tombstone of snapshot.deletedCustomAgents) {
    const bucket = deletedByBase.get(tombstone.baseAgent) ?? []
    bucket.push(buildDeletedRow(tombstone, input))
    deletedByBase.set(tombstone.baseAgent, bucket)
  }

  const rows: AgentCatalogRow[] = []
  for (const entry of catalog) {
    const base = entry.id as BuiltInTuiAgent
    const { status, commandSummary } = builtInStatus(base, entry, input, disabled)
    rows.push({
      kind: 'built-in',
      id: base,
      baseAgent: base,
      label: entry.label,
      commandSummary,
      status,
      enabled: !disabled.has(base),
      isDefault: snapshot.defaultAgent === base,
      searchSummary: buildAgentSearchSummary({
        label: entry.label,
        baseName: baseDisplayName(base),
        commandSummary
      })
    })
    rows.push(...(readyByBase.get(base) ?? []))
    rows.push(...(repairByBase.get(base) ?? []))
    rows.push(...(deletedByBase.get(base) ?? []))
  }
  rows.push(...orphanRepairs)
  return rows
}

/** Filter derived rows by an already-built summary. Normalize the raw query once
 *  (not per row); an empty query returns the list unchanged so clearing search
 *  restores it without remounting selection state. */
export function filterAgentCatalogRows(
  rows: readonly AgentCatalogRow[],
  rawQuery: string
): AgentCatalogRow[] {
  const normalized = normalizeAgentSearchQuery(rawQuery)
  if (normalized === '') {
    return rows.slice()
  }
  return rows.filter((row) => agentSearchSummaryMatches(row.searchSummary, normalized))
}

/** Stable render/action key: ids for configured rows, tombstone id for deleted,
 *  and the opaque repair token for malformed rows (never a label or index). */
export function agentCatalogRowKey(row: AgentCatalogRow): string {
  switch (row.kind) {
    case 'built-in':
    case 'custom':
    case 'deleted':
      return row.id
    case 'repair':
      return `repair:${row.repairToken}`
  }
}
