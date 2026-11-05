import React from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { formatRelativeTime } from '../activity/activity-thread-presentation'
import { revealDashboardAgent } from '../dashboard/reveal-dashboard-agent'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { homeAgentTitle } from './home-fleet-model'

export function HomeAgentRow({
  card,
  since,
  now,
  detail
}: {
  card: DashboardCard
  /** Timestamp the trailing relative time counts from; 0 hides it. */
  since: number
  now: number
  detail?: string
}): React.JSX.Element {
  const hostBadge =
    card.hostKind && card.hostKind !== 'local' ? card.hostLabel || card.hostKind : null
  return (
    <button
      type="button"
      onClick={() => {
        const revealed = revealDashboardAgent({
          repoId: card.repoId,
          worktreeId: card.worktreeId,
          executionHostId: card.executionHostId,
          tabId: card.tabId,
          leafId: card.leafId
        })
        // Why: Home only lists live cards, whose tabs may still be hydrating, so trust the reveal result.
        if (!revealed) {
          toast.info(
            translate(
              'auto.components.home.HomeAgentRow.revealFailed',
              'This agent is no longer available.'
            )
          )
        }
      }}
      className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <AgentTypeIcon agentType={card.agentType} size={14} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
          {homeAgentTitle(card)}
        </span>
        {since > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatRelativeTime(since, now)}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-[22px] text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {card.repoName} · {card.worktreeName}
        </span>
        {hostBadge ? (
          <span className="shrink-0 rounded border border-border/70 px-1 text-[10px] leading-4">
            {hostBadge}
          </span>
        ) : null}
      </span>
      {detail ? (
        <span className="truncate pl-[22px] text-[11px] text-muted-foreground">{detail}</span>
      ) : null}
    </button>
  )
}
