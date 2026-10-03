import React, { useMemo, useState } from 'react'
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BusinessmapCard } from '../../../shared/businessmap-types'
import { isBusinessmapCardDone } from '@/components/task-page-businessmap-status-tone'

export type TaskPageBusinessmapCardSection = {
  key: string
  label: string
  cards: BusinessmapCard[]
}

type TaskPageBusinessmapCardListProps = {
  formatUpdatedAt: (updatedAt: string) => string
  getStatusTone: (columnName: string, isDone: boolean) => string
  cards: readonly BusinessmapCard[]
  onOpenCard: (card: BusinessmapCard) => void
  onStartWorkspace: (card: BusinessmapCard) => void
  selectedCard: BusinessmapCard | null
}

export function groupBusinessmapCardsByColumn(
  cards: readonly BusinessmapCard[]
): TaskPageBusinessmapCardSection[] {
  const sections = new Map<string, TaskPageBusinessmapCardSection>()
  for (const card of cards) {
    const key = `${card.column.id}:${card.column.name}`
    const section = sections.get(key)
    if (section) {
      section.cards.push(card)
    } else {
      sections.set(key, { key, label: card.column.name, cards: [card] })
    }
  }
  return [...sections.values()].sort((a, b) => a.label.localeCompare(b.label))
}

function isSelectedCard(card: BusinessmapCard, selectedCard: BusinessmapCard | null): boolean {
  return selectedCard !== null && selectedCard.id === card.id
}

function BusinessmapCardRow({
  formatUpdatedAt,
  getStatusTone,
  card,
  onOpenCard,
  onStartWorkspace,
  selected
}: {
  formatUpdatedAt: (updatedAt: string) => string
  getStatusTone: (columnName: string, isDone: boolean) => string
  card: BusinessmapCard
  onOpenCard: (card: BusinessmapCard) => void
  onStartWorkspace: (card: BusinessmapCard) => void
  selected: boolean
}): React.JSX.Element {
  const done = isBusinessmapCardDone(card.column.name)
  const labels = card.labels.slice(0, 3)
  const stateLabel = card.lane ? `${card.column.name} · ${card.lane.name}` : card.column.name

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      data-current={selected ? 'true' : undefined}
      onClick={() => onOpenCard(card)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenCard(card)
        }
      }}
      className={cn(
        'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[72px_minmax(0,1fr)_132px_120px_96px_64px]',
        selected && 'bg-accent'
      )}
    >
      <span className="block truncate font-mono text-[12px] text-muted-foreground max-md:!hidden">
        #{card.id}
      </span>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground md:hidden">
            #{card.id}
          </span>
          <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">{card.title}</h3>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 md:!hidden">
          <span
            className={cn(
              'inline-flex min-w-0 items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
              getStatusTone(card.column.name, done)
            )}
          >
            <span className="truncate">{stateLabel}</span>
          </span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {card.assignee?.displayName ??
              translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 max-lg:!hidden">
          {labels.map((label) => (
            <span
              key={label}
              className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {card.labels.length > labels.length ? (
            <span className="text-[10px] text-muted-foreground">
              +{card.labels.length - labels.length}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 max-md:!hidden">
        <span
          className={cn(
            'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            getStatusTone(card.column.name, done)
          )}
        >
          <span className="truncate">{stateLabel}</span>
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground max-lg:!hidden">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[10px]">
          {card.assignee?.displayName?.slice(0, 1) ?? '-'}
        </span>
        <span className="truncate">
          {card.assignee?.displayName ??
            translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
        </span>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="block min-w-0 truncate text-[12px] text-muted-foreground max-md:!hidden">
            {formatUpdatedAt(card.updatedAt)}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {new Date(card.updatedAt).toLocaleString()}
        </TooltipContent>
      </Tooltip>

      <div className="flex shrink-0 items-center justify-end gap-1 md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                onStartWorkspace(card)
              }}
              aria-label={translate(
                'auto.components.TaskPage.businessmapStartWorkspace',
                'Start workspace from card {{value0}}',
                { value0: card.id }
              )}
            >
              <ArrowRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.TaskPage.9497f2787c', 'Start workspace')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                window.api.shell.openUrl(card.url)
              }}
              aria-label={translate(
                'auto.components.TaskPage.businessmapOpenCard',
                'Open card {{value0}} in Businessmap',
                { value0: card.id }
              )}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.TaskPage.businessmapOpenIn', 'Open in Businessmap')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function TaskPageBusinessmapCardList({
  formatUpdatedAt,
  getStatusTone,
  cards,
  onOpenCard,
  onStartWorkspace,
  selectedCard
}: TaskPageBusinessmapCardListProps): React.JSX.Element {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const sections = useMemo(() => groupBusinessmapCardsByColumn(cards), [cards])

  return (
    <div>
      {sections.map((section) => {
        const open = !collapsedGroups.has(section.key)
        return (
          <Collapsible
            key={section.key}
            open={open}
            onOpenChange={(nextOpen) => {
              setCollapsedGroups((current) => {
                const next = new Set(current)
                if (nextOpen) {
                  next.delete(section.key)
                } else {
                  next.add(section.key)
                }
                return next
              })
            }}
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex h-9 w-full items-center justify-start gap-2 px-3 text-left"
              >
                {open ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                  {section.label}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {section.cards.length}
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {section.cards.map((card) => (
                <BusinessmapCardRow
                  key={card.id}
                  formatUpdatedAt={formatUpdatedAt}
                  getStatusTone={getStatusTone}
                  card={card}
                  onOpenCard={onOpenCard}
                  onStartWorkspace={onStartWorkspace}
                  selected={isSelectedCard(card, selectedCard)}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
