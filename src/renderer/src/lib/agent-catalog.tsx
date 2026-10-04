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
  cmd: string
  searchAliases?: readonly string[]
  iconUrl?: string
  /** Domain for Google's favicon service — used for agents without an SVG icon. */
  faviconDomain?: string
  homepageUrl: string
}

export const getAgentCatalog = createLocalizedCatalog(buildAgentCatalogEntries)

// Why: tests and a few legacy call sites still import a catalog snapshot.
export const AGENT_CATALOG: AgentCatalogEntry[] = getAgentCatalog()

export function getAgentLabel(agent: TerminalAgent): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? formatAgentTypeLabel(agent)
}

type AgentIconProps = {
  agent: TerminalAgent | null | undefined
  size?: number
}

export function AgentIcon({ agent, size = 14 }: AgentIconProps): React.JSX.Element {
  // Why: render a neutral question-mark glyph when the agent identity is not
  // yet known. Before, the caller coerced null → 'claude', which caused Codex
  // panes to briefly show the Claude icon until the first hook callback
  // arrived.
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
  // Why: prefer the favicon bundled at build time so the icon renders without a
  // live network request — Google's favicon service is unreachable in some
  // regions and offline, which left these icons broken (#8451).
  const bundledFaviconUrl = AGENT_FAVICON_ASSETS[agent]
  // Why: one resolved src for guard + attribute so empty `iconUrl` cannot pass
  // a truthy `||` check while `??` still renders a broken `<img src="">`.
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
    // Why: agents without a published SVG icon or bundled favicon fall back to
    // their site favicon via Google's favicon service — same source the README
    // uses for the agent badge list.
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
