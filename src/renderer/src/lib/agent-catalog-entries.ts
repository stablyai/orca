import { TUI_AGENT_FAVICON_DOMAINS } from '../../../shared/tui-agent-favicon-domains'
import { primaryAgentCatalogEntries } from './agent-catalog-entries-primary'
import { secondaryAgentCatalogEntries } from './agent-catalog-entries-secondary'
import type { AgentCatalogEntry } from './agent-catalog'

export function buildAgentCatalogEntries(): AgentCatalogEntry[] {
  return [...primaryAgentCatalogEntries(), ...secondaryAgentCatalogEntries()].map((entry) => {
    const faviconDomain = TUI_AGENT_FAVICON_DOMAINS[entry.id]
    return faviconDomain ? { ...entry, faviconDomain } : entry
  })
}
