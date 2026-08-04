import type { TuiAgent } from '../../../../shared/types'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'

export type DefaultAgentChoice = TuiAgent | 'blank' | null

export type DefaultAgentSelectionKind = 'auto' | 'blank' | 'agent'

export type DefaultAgentSelection = {
  kind: DefaultAgentSelectionKind
  agentId: TuiAgent | null
}

export type DefaultAgentCatalogEntry = {
  id: TuiAgent
  label: string
}

/** Resolve which default-agent radio is active — mirrors Settings > Agents. */
export function resolveDefaultAgentSelection(args: {
  defaultAgent: DefaultAgentChoice | undefined
  detectedIds: ReadonlySet<string> | null
  disabledAgents: Iterable<unknown> | null | undefined
}): DefaultAgentSelection {
  const { defaultAgent, detectedIds, disabledAgents } = args
  if (defaultAgent === 'blank') {
    return { kind: 'blank', agentId: null }
  }
  if (
    defaultAgent == null ||
    (detectedIds !== null && !detectedIds.has(defaultAgent)) ||
    !isTuiAgentEnabled(defaultAgent, disabledAgents)
  ) {
    return { kind: 'auto', agentId: null }
  }
  return { kind: 'agent', agentId: defaultAgent }
}

/** Enabled + detected agents in catalog order for the status-bar picker. */
export function listSelectableDefaultAgents(args: {
  catalog: readonly DefaultAgentCatalogEntry[]
  detectedIds: ReadonlySet<string> | null
  disabledAgents: Iterable<unknown> | null | undefined
}): DefaultAgentCatalogEntry[] {
  const { catalog, detectedIds, disabledAgents } = args
  if (detectedIds === null) {
    return []
  }
  return catalog.filter(
    (entry) => detectedIds.has(entry.id) && isTuiAgentEnabled(entry.id, disabledAgents)
  )
}

export function resolveDefaultAgentTriggerLabel(args: {
  selection: DefaultAgentSelection
  agentLabel: string | null | undefined
  autoLabel: string
  blankLabel: string
}): string {
  if (args.selection.kind === 'auto') {
    return args.autoLabel
  }
  if (args.selection.kind === 'blank') {
    return args.blankLabel
  }
  return args.agentLabel?.trim() || args.selection.agentId || args.autoLabel
}
