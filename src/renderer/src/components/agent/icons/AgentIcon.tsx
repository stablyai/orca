import type React from 'react'
import { getAgentCatalog, getAgentLabel } from '../../../lib/agent-catalog/agent-catalog'
import { ClaudeIcon, DroidIcon, OpenAIIcon } from '@/components/status-bar/icons'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'
import {
  AgentLetterIcon,
  AiderIcon,
  CopilotIcon,
  KiloIcon,
  MiniMaxIcon,
  OmpIcon,
  OpenCodeIcon,
  PiIcon
} from './agent-icon-glyphs'
import { AGENT_FAVICON_ASSETS } from './agent-favicon-assets'

/** An agent's branded glyph, falling back to its catalog favicon and then a letter mark. */
export function AgentIcon({
  agent,
  size = 14,
  className
}: {
  agent: TerminalAgent | null | undefined
  size?: number
  className?: string
}): React.JSX.Element {
  // Unknown identity gets a neutral glyph so Codex panes cannot briefly display Claude’s icon before hooks arrive.
  if (!agent) {
    return <AgentLetterIcon letter="?" size={size} className={className} />
  }
  if (agent === 'claude' || agent === 'claude-agent-teams') {
    return <ClaudeIcon size={size} className={className} />
  }
  if (agent === 'codex') {
    return <OpenAIIcon size={size} className={className} />
  }
  if (agent === 'droid') {
    return <DroidIcon size={size} className={className} />
  }
  if (agent === 'pi') {
    return <PiIcon size={size} className={className} />
  }
  if (agent === 'omp') {
    return <OmpIcon size={size} className={className} />
  }
  if (agent === 'aider') {
    return <AiderIcon size={size} className={className} />
  }
  if (agent === 'kilo') {
    return <KiloIcon size={size} className={className} />
  }
  if (agent === 'copilot') {
    return <CopilotIcon size={size} className={className} />
  }
  if (agent === 'opencode' || agent === 'opencode2') {
    return <OpenCodeIcon size={size} className={className} />
  }
  if (agent === 'mcode') {
    return <MiniMaxIcon size={size} className={className} />
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
        className={className}
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
        className={className}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
      />
    )
  }
  return (
    <AgentLetterIcon
      letter={getAgentLabel(agent).charAt(0).toUpperCase()}
      size={size}
      className={className}
    />
  )
}
