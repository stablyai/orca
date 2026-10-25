import { primaryAgentCatalogEntries } from './agent-catalog-entries-primary'
import { secondaryAgentCatalogEntries } from './agent-catalog-entries-secondary'
import type { AgentCatalogEntry } from './agent-catalog'

/** The catalog rows, in display order. */
export function buildAgentCatalogEntries(): AgentCatalogEntry[] {
  return [...primaryAgentCatalogEntries(), ...secondaryAgentCatalogEntries()]
}
