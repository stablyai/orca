import type React from 'react'
import { ClaudeIcon, DroidIcon, OpenAIIcon } from '@/components/status-bar/icons'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import {
  AgentLetterIcon,
  AiderIcon,
  CopilotIcon,
  KiloIcon,
  OmpIcon,
  OpenCodeIcon,
  PiIcon
} from './agent-icon-glyphs'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { AGENT_FAVICON_ASSETS } from './agent-favicon-assets'
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

export function AgentIcon({
  agent,
  size = 14
}: {
  agent: TerminalAgent | null | undefined
  size?: number
}): React.JSX.Element {
  // Unknown identity gets a neutral glyph so Codex panes cannot briefly display Claude’s icon before hooks arrive.
  if (!agent) {
    return <AgentLetterIcon letter="?" size={size} />
  }
  if (agent === 'claude' || agent === 'claude-agent-teams') {
    return <ClaudeIcon size={size} />
  }
  if (agent === 'codex') {
    return <OpenAIIcon size={size} />
  }
  if (agent === 'droid') {
    return <DroidIcon size={size} />
  }
  if (agent === 'pi') {
    return <PiIcon size={size} />
  }
  if (agent === 'omp') {
    return <OmpIcon size={size} />
  }
  if (agent === 'aider') {
    return <AiderIcon size={size} />
  }
  if (agent === 'kilo') {
    return <KiloIcon size={size} />
  }
  if (agent === 'copilot') {
    return <CopilotIcon size={size} />
  }
  if (agent === 'opencode' || agent === 'opencode2') {
    return <OpenCodeIcon size={size} />
  }
  const catalogEntry = getAgentCatalog().find((a) => a.id === agent)
  // Prefer bundled favicons for offline use and regions where Google’s service is unreachable (#8451).
  const iconAgent = agent === 'dsb' ? 'dsh' : agent
  const bundledFaviconUrl = AGENT_FAVICON_ASSETS[iconAgent]
  // Resolve src once so empty iconUrl cannot pass a truthy fallback guard yet render src="".
  const iconSrc = catalogEntry?.iconUrl ?? bundledFaviconUrl
  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        width={size}
        height={size}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
      />
    )
  }
  if (catalogEntry?.faviconDomain) {
    // Use Google’s favicon service only when no SVG or bundled favicon exists, as in the README badges.
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${catalogEntry.faviconDomain}&sz=64`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
      />
    )
  }
  return <AgentLetterIcon letter={getAgentLabel(agent).charAt(0).toUpperCase()} size={size} />
}
