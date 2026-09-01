// The renderer's live custom-agent catalog, reachable from modules that must not
// import '@/store'. Both the launch libs and agent-status are imported BY store
// slices, so a module-scope store edge creates an initialization cycle
// (createXSlice undefined under test import order). The store registers its
// settings here right after creation instead.

import type { CustomTuiAgent, DeletedCustomTuiAgent } from '../../../shared/types'

export type AgentCatalogSettings = {
  customTuiAgents?: CustomTuiAgent[]
  deletedCustomTuiAgents?: DeletedCustomTuiAgent[]
}

let catalogSettingsSource: () => AgentCatalogSettings | null | undefined = () => null

export function registerAgentCatalogSettingsSource(
  source: () => AgentCatalogSettings | null | undefined
): void {
  catalogSettingsSource = source
}

/** Null before the store registers (and in catalog-free tests): callers then see
 *  a custom id as unresolvable rather than guessing a base from its syntax. */
export function getAgentCatalogSettings(): AgentCatalogSettings | null | undefined {
  return catalogSettingsSource()
}
