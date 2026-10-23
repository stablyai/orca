import { useAppStore } from '@/store'
import { readTerminalTabShell } from '@/store/terminals/terminal-process-metadata'
import { getAgentLabel } from '@/lib/agent-catalog'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../../shared/terminal-agent'

export function useTerminalTabShell(
  tab: Pick<TerminalTab, 'id' | 'shellOverride'>,
  agent: TerminalAgent | null
) {
  const shell = useAppStore((state) => readTerminalTabShell(state, tab))
  const programName = agent
    ? getAgentLabel(agent)
    : shell
      ? basename(shell)
      : translate('tabHoverCard.terminal', 'Terminal')
  return { shell: shell ?? undefined, programName }
}
