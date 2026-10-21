import { useState } from 'react'
import { XIcon } from 'lucide-react'
import type { DashboardBucket, DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { AgentKanbanCard } from './AgentKanbanCard'
import { AgentKanbanLaneNameInput } from './AgentKanbanLaneNameInput'
import type { AgentBoardColumn } from './agent-board-columns'

/** MIME type for a dragged card; carries the card's paneKey. */
export const AGENT_CARD_DRAG_TYPE = 'application/x-orca-agent-card'

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

type AgentKanbanColumnProps = {
  column: AgentBoardColumn
  cards: DashboardCard[]
  repoIconsByRepoId: Record<string, RepoIcon | null> | undefined
  now: number
  onOpenTerminal: (card: DashboardCard) => void
  /** Whether a card currently being dragged may land here. */
  canDrop: boolean
  onCardDragStart: (card: DashboardCard) => void
  onCardDragEnd: () => void
  onDropCard: (column: AgentBoardColumn) => void
  onRenameLane: (laneId: string, label: string) => void
  onRemoveLane: (laneId: string) => void
}

export function AgentKanbanColumn({
  column,
  cards,
  repoIconsByRepoId,
  now,
  onOpenTerminal,
  canDrop,
  onCardDragStart,
  onCardDragEnd,
  onDropCard,
  onRenameLane,
  onRemoveLane
}: AgentKanbanColumnProps): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const lane = column.kind === 'lane' ? column.lane : null
  const label = column.kind === 'lane' ? column.lane.label : bucketLabel(column.bucket)

  return (
    // Why: attention no longer tints the whole column — the cards inside carry
    // their own state color, so a column border would double-signal it.
    <section
      aria-label={label}
      data-agent-board-column={column.key}
      onDragOver={(event) => {
        if (!canDrop || !event.dataTransfer.types.includes(AGENT_CARD_DRAG_TYPE)) {
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDragOver(true)
      }}
      onDragLeave={(event) => {
        // Moving between children fires leave on the parent; only a real exit clears.
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setDragOver(false)
        }
      }}
      onDrop={(event) => {
        setDragOver(false)
        if (!canDrop) {
          return
        }
        event.preventDefault()
        onDropCard(column)
      }}
      className={cn(
        'flex min-w-[264px] flex-1 flex-col rounded-xl border border-border/60 bg-muted/30 transition-colors',
        lane && 'border-dashed',
        dragOver && 'border-ring bg-accent/40'
      )}
    >
      <header className="group/lane flex items-center gap-2 px-3 py-2">
        {lane && renaming ? (
          <AgentKanbanLaneNameInput
            initialValue={lane.label}
            ariaLabel={translate('dashboardPopout.lane.renameLabel', 'Lane name')}
            onCommit={(next) => {
              setRenaming(false)
              onRenameLane(lane.id, next)
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span
            className="truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground"
            onDoubleClick={lane ? () => setRenaming(true) : undefined}
            title={
              lane
                ? translate('dashboardPopout.lane.renameHint', 'Double-click to rename')
                : undefined
            }
          >
            {label}
          </span>
        )}
        <span className="ml-auto rounded-full bg-background px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {cards.length}
        </span>
        {lane ? (
          <button
            type="button"
            onClick={() => onRemoveLane(lane.id)}
            aria-label={translate('dashboardPopout.lane.remove', 'Remove lane {{name}}', {
              name: lane.label
            })}
            className="rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/lane:opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <XIcon className="size-3" />
          </button>
        ) : null}
      </header>
      <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {cards.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {lane
              ? translate('dashboardPopout.lane.empty', 'Drag agents here')
              : translate('dashboardPopout.bucket.empty', 'None')}
          </p>
        ) : (
          cards.map((card) => {
            // Why: a question must stay in Needs You — parking it would hide it.
            const draggable = card.bucket !== 'attention'
            return (
              <div
                key={card.paneKey}
                draggable={draggable}
                onDragStart={(event) => {
                  event.dataTransfer.setData(AGENT_CARD_DRAG_TYPE, card.paneKey)
                  event.dataTransfer.effectAllowed = 'move'
                  onCardDragStart(card)
                }}
                onDragEnd={onCardDragEnd}
                className={cn(draggable && 'cursor-grab active:cursor-grabbing')}
              >
                <AgentKanbanCard
                  card={card}
                  repoIcon={repoIconsByRepoId?.[card.repoId] ?? null}
                  now={now}
                  onOpenTerminal={onOpenTerminal}
                />
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
