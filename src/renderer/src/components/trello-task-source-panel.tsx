import { LoaderCircle } from 'lucide-react'
import type { TrelloCard } from '../../../shared/trello-types'
import { Button } from '@/components/ui/button'
import { TrelloConnectDialog } from '@/components/trello-connect-dialog'
import { TrelloCardDetail } from '@/components/trello-card-detail'
import { TrelloCreateCardDialog } from '@/components/trello-create-card-dialog'
import { TrelloIcon } from '@/components/icons/TrelloIcon'
import { TrelloTaskSourceCardViews } from '@/components/trello-task-source-card-views'
import { TrelloTaskSourceControls } from '@/components/trello-task-source-controls'
import { useTrelloTaskSourceController } from '@/components/trello-task-source-controller'

type TrelloTaskSourcePanelProps = {
  onUseCard: (card: TrelloCard, renderedText?: string) => void
}

export function TrelloTaskSourcePanel({
  onUseCard
}: TrelloTaskSourcePanelProps): React.JSX.Element {
  const source = useTrelloTaskSourceController()

  if (!source.trelloStatusChecked) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!source.trelloStatus.connected) {
    return (
      <div className="mt-4 rounded-md border border-border/50 bg-muted/30 p-6 text-center">
        <TrelloIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
        <h3 className="text-sm font-medium">Connect Trello</h3>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          Add Trello access to browse cards, search boards, and start workspaces from cards.
        </p>
        <Button className="mt-4" size="sm" onClick={() => source.setConnectOpen(true)}>
          Add Trello access
        </Button>
        <TrelloConnectDialog
          open={source.connectOpen}
          onOpenChange={source.setConnectOpen}
          onConnected={source.refreshCards}
        />
      </div>
    )
  }

  if (source.selectedCard) {
    return (
      <div className="mt-3 flex min-h-0 max-h-full flex-col">
        <TrelloCardDetail
          card={source.selectedCard}
          onClose={() => source.setSelectedCard(null)}
          onUse={onUseCard}
          backLabel={source.activeBackLabel}
          onUpdated={source.onSelectedCardUpdated}
        />
      </div>
    )
  }

  return (
    <div className="mt-3 flex min-h-0 max-h-full flex-col rounded-md border border-border/50 bg-muted/50 shadow-sm">
      <TrelloTaskSourceControls
        query={source.query}
        onQueryChange={source.setQuery}
        boards={source.boards}
        boardLists={source.boardLists}
        selectedBoardId={source.selectedBoardId}
        selectedBoardLabel={source.selectedBoardLabel}
        onBoardChange={source.setSelectedBoardId}
        selectedListId={source.selectedListId}
        selectedListLabel={source.selectedListLabel}
        onListChange={source.setSelectedListId}
        viewMode={source.viewMode}
        onViewModeChange={source.setViewMode}
        groupBy={source.groupBy}
        onGroupByChange={source.setGroupBy}
        orderBy={source.orderBy}
        onOrderByChange={source.setOrderBy}
        filter={source.filter}
        onFilterChange={source.setFilter}
        loading={source.loading}
        onRefresh={() => void source.refreshCards({ force: true })}
        onCreate={() => void source.openCreateDialog()}
      />

      {source.error ? (
        <p className="border-b border-border/50 px-3 py-2 text-xs text-destructive">
          {source.error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 h-full overflow-auto scrollbar-sleek scrollbar-sleek-lg">
          <TrelloTaskSourceCardViews
            loading={source.loading}
            orderedCards={source.orderedCards}
            viewMode={source.viewMode}
            selectedBoardId={source.selectedBoardId}
            boardLists={source.boardLists}
            cardsByListId={source.cardsByListId}
            groupedCards={source.groupedCards}
            boardNameById={source.boardNameById}
            listNameById={source.listNameById}
            truncated={source.truncated}
            onSelectCard={source.setSelectedCard}
            onUseCard={onUseCard}
          />
        </div>
      </div>

      <TrelloCreateCardDialog
        open={source.createOpen}
        onOpenChange={source.setCreateOpen}
        boards={source.boards}
        defaultBoardId={source.selectedBoardId}
        onCreated={source.onCreatedCard}
      />
    </div>
  )
}
