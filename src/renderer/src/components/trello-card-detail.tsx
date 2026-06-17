import type { TrelloCard } from '../../../shared/trello-types'
import { TrelloCardDetailHeader } from '@/components/trello-card-detail-header'
import { TrelloCardDetailMainColumn } from '@/components/trello-card-detail-main-column'
import { TrelloCardDetailSidebar } from '@/components/trello-card-detail-sidebar'
import { copyTrelloCardDetailText } from '@/components/trello-card-detail-actions'
import { useTrelloCardDetailController } from '@/components/trello-card-detail-controller'

type TrelloCardDetailProps = {
  card: TrelloCard
  onClose: () => void
  onUpdated: (card: TrelloCard) => void
  onUse: (card: TrelloCard, renderedText?: string) => void
  backLabel?: string
}

export function TrelloCardDetail({
  card,
  onClose,
  onUpdated,
  onUse,
  backLabel
}: TrelloCardDetailProps): React.JSX.Element {
  const detail = useTrelloCardDetailController({ card, onUpdated })

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      <TrelloCardDetailHeader
        card={detail.displayed}
        loading={detail.loading}
        backLabel={backLabel}
        onClose={onClose}
        onCopyUrl={() => void copyTrelloCardDetailText(detail.displayed.url, 'URL')}
        onCopyShortLink={() =>
          void copyTrelloCardDetailText(
            detail.displayed.shortUrl ||
              `https://trello.com/c/${detail.displayed.shortLink || detail.displayed.id}`,
            'Short link'
          )
        }
        onStartWorkspace={() => onUse(detail.displayed, detail.renderedContext)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="mx-auto grid w-full grid-cols-1 gap-10 px-7 py-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:px-10 xl:px-12">
          <TrelloCardDetailMainColumn
            card={detail.displayed}
            title={detail.title}
            description={detail.description}
            dirty={detail.dirty}
            saving={detail.saving}
            error={detail.error}
            comments={detail.comments}
            commentsLoading={detail.commentsLoading}
            commentsError={detail.commentsError}
            commentText={detail.commentText}
            commentSubmitting={detail.commentSubmitting}
            resolveTrelloImageSrc={detail.resolveTrelloImageSrc}
            onTitleChange={detail.onTitleChange}
            onDescriptionChange={detail.onDescriptionChange}
            onDescriptionSave={(nextValue) => void detail.onDescriptionSave(nextValue)}
            onSave={() => void detail.onSave()}
            onArchiveToggle={() => void detail.onArchiveToggle()}
            onCommentTextChange={detail.setCommentText}
            onRetryComments={() => void detail.onRetryComments({ force: true })}
            onAddComment={() => void detail.onAddComment()}
          />

          <TrelloCardDetailSidebar
            card={detail.displayed}
            listId={detail.listId}
            lists={detail.lists}
            boardMembers={detail.boardMembers}
            boardLabels={detail.boardLabels}
            saving={detail.saving}
            actionItems={detail.actionItems}
            onListChange={(nextListId) => void detail.onListChange(nextListId)}
            onMemberToggle={(memberId) => void detail.onMemberToggle(memberId)}
            onLabelToggle={(labelId) => void detail.onLabelToggle(labelId)}
          />
        </div>
      </div>
    </div>
  )
}
