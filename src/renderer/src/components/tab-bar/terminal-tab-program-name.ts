import type { TerminalAgent } from '../../../../shared/terminal-agent'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { basename } from '@/lib/path'

/** The hover card's program line: the agent's name, else the tab's shell, else plain Terminal. */
export function terminalTabProgramName(agent: TerminalAgent | null, shell?: string): string {
  if (agent) {
    return getAgentLabel(agent)
  }
  return shell ? basename(shell) : translate('tabHoverCard.terminal', 'Terminal')
}
