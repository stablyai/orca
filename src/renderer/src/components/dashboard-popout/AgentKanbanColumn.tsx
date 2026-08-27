import type { DashboardBucket, DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { translate } from '@/i18n/i18n'
import { AgentKanbanCard } from './AgentKanbanCard'

function bucketLabel(bucket: DashboardBucket): string {
  switch (bucket) {
    case 'attention':
      return translate('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return translate('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return translate('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return translate('dashboardPopout.bucket.idle', 'Idle')
  }
}

export function AgentKanbanColumn({
  bucket,
  cards,
  repoIconsByRepoId,
  now,
  onOpenTerminal,
  onStop
}: {
  bucket: DashboardBucket
  cards: DashboardCard[]
  repoIconsByRepoId: Record<string, RepoIcon | null> | undefined
  now: number
  onOpenTerminal: (card: DashboardCard) => void
  onStop: (card: DashboardCard) => void
}): React.JSX.Element {
  return (
    // Why: attention no longer tints the whole column — the cards inside carry
    // their own state color, so a column border would double-signal it.
    <section className="flex min-w-[264px] flex-1 flex-col rounded-xl border border-border/60 bg-muted/30">
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {bucketLabel(bucket)}
        </span>
        <span className="ml-auto rounded-full bg-background px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {cards.length}
        </span>
      </header>
      <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {cards.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {translate('dashboardPopout.bucket.empty', 'None')}
          </p>
        ) : (
          cards.map((card) => (
            <AgentKanbanCard
              key={card.paneKey}
              card={card}
              repoIcon={repoIconsByRepoId?.[card.repoId] ?? null}
              now={now}
              onOpenTerminal={onOpenTerminal}
              onStop={onStop}
            />
          ))
        )}
      </div>
    </section>
  )
}
