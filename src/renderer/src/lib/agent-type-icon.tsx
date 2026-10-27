import type React from 'react'
import type { AgentType } from '../../../shared/agent-status-types'
import { AgentIcon } from './agent-catalog'
import { AgentLetterIcon } from './agent-icon-glyphs'
import { agentTypeToIconAgent } from './agent-status'

/** Status-row icon: known agents get their brand icon, any other OSC 7501 program its first letter. */
export function AgentTypeIcon({
  agentType,
  size = 14
}: {
  agentType: AgentType | null | undefined
  size?: number
}): React.JSX.Element {
  const iconAgent = agentTypeToIconAgent(agentType)
  if (iconAgent) {
    return <AgentIcon agent={iconAgent} size={size} />
  }
  // Why: keep "?" for not-yet-identified agents rather than a letter for "unknown".
  if (!agentType || agentType === 'unknown') {
    return <AgentIcon agent={null} size={size} />
  }
  return <AgentLetterIcon letter={programLetter(agentType)} size={size} />
}

/** OSC 7501 app ids may lead with `_.+-`; the first letter or digit is the readable one. */
function programLetter(program: string): string {
  return program.match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() ?? '?'
}
