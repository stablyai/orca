import type { ComponentProps, ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { basename } from '@/lib/path'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
import { TabHoverCard } from './TabHoverCard'
import { useClaudeTabAccountLabel } from './use-claude-tab-account-label'

/** A terminal tab's hover card: what runs in it, and the Claude account a pinned agent runs on. */
export function TerminalTabHoverCard({
  tab,
  title,
  agent,
  shell,
  icon,
  alert,
  children
}: {
  tab: Pick<TerminalTab, 'id' | 'worktreeId'>
  title: string
  agent: TerminalAgent | null
  shell: string | null | undefined
  icon: ReactNode
  alert?: ComponentProps<typeof TabHoverCard>['alert']
  children: ReactNode
}): React.JSX.Element {
  const { label: accountLabel, onTooltipOpenChange } = useClaudeTabAccountLabel(tab)
  const programName = agent
    ? [getAgentLabel(agent), accountLabel].filter(Boolean).join(' · ')
    : shell
      ? basename(shell)
      : translate('tabHoverCard.terminal', 'Terminal')
  return (
    <TabHoverCard
      title={title}
      programName={programName}
      icon={icon}
      alert={alert}
      onOpenChange={onTooltipOpenChange}
    >
      {children}
    </TabHoverCard>
  )
}
