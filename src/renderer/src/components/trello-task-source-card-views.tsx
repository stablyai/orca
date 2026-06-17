import { ArrowRight, EllipsisVertical, ExternalLink, LoaderCircle } from 'lucide-react'
import type { TrelloCard, TrelloList } from '../../../shared/trello-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TrelloIcon } from '@/components/icons/TrelloIcon'
import type { TrelloViewMode } from '@/components/trello-task-source-controls'

export type TrelloCardGroup = {
  key: string
  label: string
  cards: TrelloCard[]
}

type TrelloTaskSourceCardViewsProps = {
  loading: boolean
  orderedCards: TrelloCard[]
  viewMode: TrelloViewMode
  selectedBoardId: string
  boardLists: TrelloList[]
  cardsByListId: Map<string, TrelloCard[]>
  groupedCards: TrelloCardGroup[]
  boardNameById: Map<string, string>
  listNameById: Map<string, string>
  truncated: boolean
  onSelectCard: (card: TrelloCard) => void
  onUseCard: (card: TrelloCard, renderedText?: string) => void
}

function renderTrelloCardContext(card: TrelloCard): string {
  return [
    `Trello card: ${card.name}`,
    `URL: ${card.url}`,
    card.boardName ? `Board: ${card.boardName}` : null,
    card.listName ? `List: ${card.listName}` : null,
    card.desc ? `\nDescription:\n${card.desc}` : null
  ]
    .filter(Boolean)
    .join('\n')
}

function formatTrelloDate(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  return new Date(value).toLocaleDateString()
}

export function TrelloTaskSourceCardViews({
  loading,
  orderedCards,
  viewMode,
  selectedBoardId,
  boardLists,
  cardsByListId,
  groupedCards,
  boardNameById,
  listNameById,
  truncated,
  onSelectCard,
  onUseCard
}: TrelloTaskSourceCardViewsProps): React.JSX.Element {
  if (loading && orderedCards.length === 0) {
    return (
      <div className="flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (orderedCards.length === 0) {
    return (
      <div className="py-14 text-center text-sm text-muted-foreground">No Trello cards found.</div>
    )
  }

  let content: React.JSX.Element
  if (viewMode === 'board') {
    if (selectedBoardId === 'all') {
      return (
        <div className="py-14 text-center text-sm text-muted-foreground">
          Select a specific board to use Board view.
        </div>
      )
    }
    content = (
      <TrelloBoardCardView
        boardLists={boardLists}
        cardsByListId={cardsByListId}
        onSelectCard={onSelectCard}
      />
    )
  } else {
    content = (
      <TrelloGroupedCardList
        groupedCards={groupedCards}
        boardNameById={boardNameById}
        listNameById={listNameById}
        onSelectCard={onSelectCard}
        onUseCard={onUseCard}
      />
    )
  }

  return (
    <>
      {content}
      {truncated && (
        <div className="border-t border-border/50 px-3 py-2.5 text-center text-[11px] text-muted-foreground/70">
          Showing the first 50 results. Use the search or filter to narrow results.
        </div>
      )}
    </>
  )
}

type TrelloBoardCardViewProps = {
  boardLists: TrelloList[]
  cardsByListId: Map<string, TrelloCard[]>
  onSelectCard: (card: TrelloCard) => void
}

function TrelloBoardCardView({
  boardLists,
  cardsByListId,
  onSelectCard
}: TrelloBoardCardViewProps): React.JSX.Element {
  return (
    <div className="flex min-h-full gap-3 overflow-x-auto p-3">
      {boardLists.map((list) => (
        <TrelloBoardColumn
          key={list.id}
          list={list}
          cards={cardsByListId.get(list.id) ?? []}
          onSelectCard={onSelectCard}
        />
      ))}
    </div>
  )
}

type TrelloBoardColumnProps = {
  list: TrelloList
  cards: TrelloCard[]
  onSelectCard: (card: TrelloCard) => void
}

function TrelloBoardColumn({
  list,
  cards,
  onSelectCard
}: TrelloBoardColumnProps): React.JSX.Element {
  return (
    <section className="flex max-h-full w-72 shrink-0 flex-col rounded-md border border-border/50 bg-background/60">
      <div className="border-b border-border/50 px-3 py-2">
        <p className="truncate text-xs font-semibold text-foreground">{list.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {cards.length} card{cards.length === 1 ? '' : 's'}
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2 scrollbar-sleek">
        {cards.map((card) => (
          <TrelloBoardCard key={card.id} card={card} onSelectCard={onSelectCard} />
        ))}
      </div>
    </section>
  )
}

type TrelloBoardCardProps = {
  card: TrelloCard
  onSelectCard: (card: TrelloCard) => void
}

function TrelloBoardCard({ card, onSelectCard }: TrelloBoardCardProps): React.JSX.Element {
  return (
    <button
      className="w-full rounded-md border border-border/60 bg-card px-3 py-2 text-left shadow-xs transition-colors hover:bg-muted"
      onClick={() => onSelectCard(card)}
    >
      <p className="line-clamp-2 text-sm font-medium text-foreground">{card.name}</p>
      {card.desc ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{card.desc}</p>
      ) : null}
      {card.labels.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {card.labels
            .filter((label) => label.name)
            .slice(0, 3)
            .map((label) => (
              <span
                key={label.id || label.name}
                className="rounded-full border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {label.name}
              </span>
            ))}
        </div>
      ) : null}
    </button>
  )
}

type TrelloGroupedCardListProps = {
  groupedCards: TrelloCardGroup[]
  boardNameById: Map<string, string>
  listNameById: Map<string, string>
  onSelectCard: (card: TrelloCard) => void
  onUseCard: (card: TrelloCard, renderedText?: string) => void
}

function TrelloGroupedCardList({
  groupedCards,
  boardNameById,
  listNameById,
  onSelectCard,
  onUseCard
}: TrelloGroupedCardListProps): React.JSX.Element {
  return (
    <div className="divide-y divide-border/50">
      {groupedCards.map((group) => (
        <section key={group.key} className="bg-background/20">
          <div className="sticky top-0 z-20 grid grid-cols-[minmax(220px,1.8fr)_140px_140px_110px_110px_96px] gap-3 border-b border-border/50 bg-muted/90 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground backdrop-blur">
            <span>{group.label}</span>
            <span>Board</span>
            <span>List</span>
            <span>Due</span>
            <span>Updated</span>
            <span />
          </div>
          <div className="divide-y divide-border/40">
            {group.cards.map((card) => (
              <TrelloListCard
                key={card.id}
                card={card}
                boardName={card.boardName || boardNameById.get(card.idBoard) || '—'}
                listName={card.listName || listNameById.get(card.idList) || '—'}
                onSelectCard={onSelectCard}
                onUseCard={onUseCard}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

type TrelloListCardProps = {
  card: TrelloCard
  boardName: string
  listName: string
  onSelectCard: (card: TrelloCard) => void
  onUseCard: (card: TrelloCard, renderedText?: string) => void
}

function TrelloListCard({
  card,
  boardName,
  listName,
  onSelectCard,
  onUseCard
}: TrelloListCardProps): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      className="group grid cursor-pointer grid-cols-[minmax(220px,1.8fr)_140px_140px_110px_110px_96px] gap-3 px-3 py-2 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => onSelectCard(card)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          const target = event.target as HTMLElement
          const interactiveTarget = target.closest(
            'button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="link"], [role="menuitemradio"], [role="option"]'
          )
          if (interactiveTarget && interactiveTarget !== event.currentTarget) {
            return
          }
          event.preventDefault()
          onSelectCard(card)
        }
      }}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <TrelloIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <h3 className="truncate text-sm font-semibold text-foreground">{card.name}</h3>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {card.desc ? <span className="line-clamp-1">{card.desc}</span> : null}
          {card.labels
            .filter((label) => label.name)
            .slice(0, 3)
            .map((label) => (
              <span
                key={label.id || label.name}
                className="rounded-full border border-border/50 bg-background/80 px-1.5 py-0 text-[10px] text-muted-foreground"
              >
                {label.name}
              </span>
            ))}
        </div>
      </div>
      <div className="min-w-0 self-center text-xs text-muted-foreground">
        <span className="truncate">{boardName}</span>
      </div>
      <div className="min-w-0 self-center text-xs text-muted-foreground">
        <span className="truncate">{listName}</span>
      </div>
      <div className="self-center text-[11px] text-muted-foreground">
        {formatTrelloDate(card.due)}
      </div>
      <div className="self-center text-[11px] text-muted-foreground">
        {formatTrelloDate(card.dateLastActivity)}
      </div>
      <div className="flex items-center justify-end gap-1 self-center">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onUseCard(card, renderTrelloCardContext(card))
          }}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/80 px-2 py-1 text-[11px] text-foreground transition hover:bg-muted/60"
        >
          Start
          <ArrowRight className="size-3" />
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
              aria-label="More Trello card actions"
            >
              <EllipsisVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem onSelect={() => onSelectCard(card)}>
              <TrelloIcon className="size-4" />
              View details
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.api.shell.openUrl(card.url)}>
              <ExternalLink className="size-4" />
              Open in Trello
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
