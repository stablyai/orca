import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { revealDashboardAgent } from '@/components/dashboard/navigation/reveal-dashboard-agent'
import { groupPendingDecisions } from '../../../../shared/commander/decision-inbox'
import type { DashboardCard } from '../../../../shared/agent-status/presentation/dashboard-snapshot'

export function CommanderDecisionInbox({
  cards
}: {
  cards: readonly DashboardCard[]
}): React.JSX.Element {
  const t = useTranslate()
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const groups = useMemo(
    () =>
      groupPendingDecisions(
        cards.map((card) => ({
          id: JSON.stringify([card.executionHostId ?? 'local', card.worktreeId, card.paneKey]),
          state: card.dotState,
          summary: card.askSummary,
          since: card.stateChangedAt,
          value: card
        }))
      ),
    [cards]
  )
  if (!groups.length) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t('commander.inboxEmpty', 'No pending agent decisions.')}
      </p>
    )
  }
  return (
    <div className="scrollbar-sleek h-full overflow-auto px-4 py-2">
      {groups.map((group) => (
        <details key={group.id} className="max-w-3xl border-b border-border text-sm">
          <summary className="cursor-pointer break-words rounded-sm py-3 font-medium focus-visible:outline-ring">
            {group.summary || group.requests[0]!.value.task || t('commander.blocked', 'Blocked')}{' '}
            <span className="ml-1 text-xs font-normal tabular-nums text-muted-foreground">
              {t('commander.inboxCount', 'Requests: {{count}}', { count: group.requests.length })}
            </span>
          </summary>
          <ul className="space-y-1 pb-2">
            {group.requests.map(({ id, value: card }) => (
              <li key={id} className="px-1 py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto max-w-full justify-start whitespace-normal text-left"
                  onClick={() => setUnavailable(revealDashboardAgent(card) ? null : id)}
                >
                  <span className="min-w-0 break-words">
                    {card.repoName} · {card.worktreeName} ·{' '}
                    {card.conversationName || card.task || card.agentType}
                    {card.hostLabel || card.executionHostId
                      ? ` · ${card.hostLabel || card.executionHostId}`
                      : ''}
                  </span>
                </Button>
                {unavailable === id && (
                  <p role="alert" className="px-2 text-xs text-destructive">
                    {t('commander.inboxUnavailable', 'This agent session could not be opened.')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  )
}
