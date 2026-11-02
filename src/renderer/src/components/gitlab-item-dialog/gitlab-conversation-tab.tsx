import { LoaderCircle } from 'lucide-react'
import { TabsContent } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import { CommentCard } from '../gitlab-item-dialog-parts'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'
import type { GitLabReviewActions } from './use-gitlab-review-actions'

type Props = {
  item: GitLabWorkItem
  state: GitLabItemDialogState
  reviewActions: GitLabReviewActions
}

export function GitLabConversationTab({ item, state, reviewActions }: Props) {
  const { details, loading, resolvingThreadId } = state
  const isMR = item.type === 'mr'
  return (
    <TabsContent value="conversation" className="mt-0 space-y-3">
      {loading && !details ? (
        <div className="flex items-center justify-center py-12">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : details?.comments?.length ? (
        details.comments.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            canResolve={isMR}
            resolving={resolvingThreadId === comment.threadId}
            onResolve={(threadId, resolved) =>
              void reviewActions.handleResolveDiscussion(threadId, resolved)
            }
          />
        ))
      ) : (
        <p className="text-sm text-muted-foreground">
          {translate('auto.components.GitLabItemDialog.85a8170279', 'No comments yet.')}
        </p>
      )}
    </TabsContent>
  )
}
