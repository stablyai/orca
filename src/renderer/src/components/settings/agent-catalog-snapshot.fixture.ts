// Test-only builders for a production-shaped LocalAgentCatalogSnapshot and its
// ready custom entries, shared by the section/default-option/connected-path
// suites so each asserts against the exact preload output type.

import type {
  AgentCatalogRepairIssue,
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../../shared/agent-catalog-snapshot'
import type { BuiltInTuiAgent, CustomTuiAgentId } from '../../../../shared/types'

export function buildReadyCustom(
  overrides: {
    id?: CustomTuiAgentId
    base?: BuiltInTuiAgent
    label?: string
    commandOverride?: string
    args?: string
    availabilityReason?: 'baseline-stock' | 'configured-executable' | 'custom-path'
  } = {}
): LocalCustomTuiAgent {
  const base = overrides.base ?? 'codex'
  return {
    status: 'ready',
    definition: {
      id: overrides.id ?? (`custom-agent:${base}:one` as CustomTuiAgentId),
      baseAgent: base,
      label: overrides.label ?? 'My Codex',
      commandOverride: overrides.commandOverride,
      args: overrides.args ?? '',
      syncEnv: false
    },
    envSummary: { entryCount: 0, bytes: 0 },
    availabilityReason: overrides.availabilityReason ?? 'baseline-stock'
  }
}

export function buildRepairCustom(
  overrides: {
    repairToken?: string
    id?: CustomTuiAgentId
    base?: BuiltInTuiAgent
    label?: string | null
    issues?: AgentCatalogRepairIssue[]
    draftAvailability?: 'available' | 'too-large'
  } = {}
): LocalCustomTuiAgent {
  return {
    status: 'repair-required',
    id: overrides.id,
    baseAgent: overrides.base,
    label: overrides.label ?? null,
    repairToken: overrides.repairToken ?? 'token-1',
    issues: overrides.issues ?? [{ field: 'args', reason: 'unterminated_quote' }],
    rawBytes: 128,
    draftAvailability: overrides.draftAvailability ?? 'available'
  }
}

export function buildLocalCatalogSnapshot(
  overrides: Partial<LocalAgentCatalogSnapshot> = {}
): LocalAgentCatalogSnapshot {
  return {
    version: 1,
    revision: 1,
    defaultAgent: 'auto',
    disabledAgents: [],
    customAgents: [],
    deletedCustomAgents: [],
    repairIssues: [],
    projection: { status: 'ready', bytes: 0, maxBytes: 524_288 },
    localStorage: { status: 'ready', bytes: 0, maxBytes: 16_777_216 },
    ...overrides
  }
}
