import '@/components/status-bar/icons'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import '../../components/agent/icons/agent-icon-glyphs'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import '../../components/agent/icons/agent-favicon-assets'
import { buildAgentCatalogEntries } from './agent-catalog-entries'

export type AgentCatalogEntry = {
  id: TuiAgent
  label: string
  /** Default CLI binary name used for PATH detection. */
  cmd: string
  searchAliases?: readonly string[]
  /** Direct or bundled image URL for agents whose project identity is not represented by a favicon service. */
  iconUrl?: string
  /** Domain for Google's favicon service — used for agents without an SVG icon. */
  faviconDomain?: string
  /** Homepage/install docs URL, sourced from the README agent badge list. */
  homepageUrl: string
}

export const getAgentCatalog = createLocalizedCatalog(buildAgentCatalogEntries)

// Why: tests and a few legacy call sites still import a catalog snapshot.
export const AGENT_CATALOG: AgentCatalogEntry[] = getAgentCatalog()

export function getAgentLabel(agent: TerminalAgent): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? formatAgentTypeLabel(agent)
}
