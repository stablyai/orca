import type { ComponentProps, ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { basename } from '@/lib/path'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'
import { TabHoverCard } from '../strip/TabHoverCard'
import { useClaudeTabAccountLabel } from './use-claude-tab-account-label'

/** A terminal tab's hover card: what runs in it, and the Claude account a pinned agent runs on. */
export function TerminalTabHoverCard({
  tab,
  title,
  agent,
  shell,
  identityDetail,
  icon,
  alert,
  description,
  showWhenUnclipped = false,
  children
}: {
  tab: Pick<TerminalTab, 'id' | 'worktreeId'>
  title: string
  agent: TerminalAgent | null
  shell: string | null | undefined
  identityDetail?: string
  icon: ReactNode
  alert?: ComponentProps<typeof TabHoverCard>['alert']
  description?: ComponentProps<typeof TabHoverCard>['description']
  showWhenUnclipped?: boolean
  children: ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const { label: accountLabel, pinned, onTooltipOpenChange } = useClaudeTabAccountLabel(tab)
  const programName =
    identityDetail ??
    (agent
      ? [getAgentLabel(agent), accountLabel].filter(Boolean).join(' · ')
      : shell
        ? basename(shell)
        : t('tabHoverCard.terminal', 'Terminal'))
  return (
    <TabHoverCard
      title={title}
      programName={programName}
      icon={icon}
      alert={alert}
      description={description}
      showWhenUnclipped={
        showWhenUnclipped || identityDetail !== undefined || (pinned && agent !== null)
      }
      programNameIsProse={identityDetail !== undefined}
      onOpenChange={onTooltipOpenChange}
    >
      {children}
    </TabHoverCard>
  )
}
