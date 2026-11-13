import React from 'react'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { CompactAgentExpansion, CompactAgentSummaryButton } from './worktree-card-compact-agents'

type Props = {
  agents: DashboardAgentRow[]
  hasLineage: boolean
  expanded: boolean
  sendTargetMode: boolean
  className?: string
  rootRef: React.Ref<HTMLDivElement>
  onToggle: () => void
  renderAgent: (agent: DashboardAgentRow, expanded?: boolean) => React.ReactNode
  renderHeader?: (summary: React.ReactNode) => React.ReactElement
}

const stopBubble = (event: React.SyntheticEvent) => event.stopPropagation()

export function WorktreeCardAgentList({
  agents,
  hasLineage,
  expanded,
  sendTargetMode,
  className,
  rootRef,
  onToggle,
  renderAgent,
  renderHeader
}: Props): React.JSX.Element {
  const t = useTranslate()
  const subjectLabel = t('sidebar.agentSummary.agentCount', '{{count}} agents', {
    count: agents.length,
    defaultValue_one: '{{count}} agent'
  })
  const listProps = {
    ref: rootRef,
    role: hasLineage ? 'tree' : 'group',
    'aria-label': t('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents'),
    onClick: stopBubble,
    onDoubleClick: stopBubble,
    onMouseDown: stopBubble,
    onPointerDown: stopBubble
  }
  if (renderHeader) {
    const open = expanded || sendTargetMode
    return (
      <>
        {renderHeader(
          <CompactAgentSummaryButton
            agents={agents}
            subjectLabel={subjectLabel}
            expanded={open}
            onToggle={onToggle}
            inline
          />
        )}
        <CompactAgentExpansion expanded={open}>
          <div {...listProps} className={className}>
            {agents.map((agent) => renderAgent(agent, open))}
          </div>
        </CompactAgentExpansion>
      </>
    )
  }
  const showSummary = agents.length > 1 && !sendTargetMode
  return (
    <div
      {...listProps}
      className={cn('flex flex-col mt-1 gap-0.5', className)}
      data-compact-agent-list="true"
    >
      {showSummary ? (
        <div
          className={cn(
            'compact-agent-summary-panel',
            expanded && 'compact-agent-summary-panel-expanded'
          )}
        >
          <CompactAgentSummaryButton
            agents={agents}
            subjectLabel={subjectLabel}
            expanded={expanded}
            onToggle={onToggle}
          />
          <CompactAgentExpansion expanded={expanded}>
            {agents.map((agent) => renderAgent(agent, expanded))}
          </CompactAgentExpansion>
        </div>
      ) : (
        agents.map((agent) => renderAgent(agent))
      )}
    </div>
  )
}
