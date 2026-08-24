import { Eye, EyeOff } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { reviewThreadBadgeTitle } from './review-thread-copy'
import { setReviewThreadsVisible } from './review-thread-visibility'

/** One-line header above a branch diff: thread count plus the shared hide/show toggle. */
export function ReviewThreadsToggleBar({
  threadCount,
  visible
}: {
  threadCount: number
  visible: boolean
}): React.JSX.Element | null {
  if (threadCount === 0) {
    return null
  }
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-1 text-xs text-muted-foreground">
      <span>{reviewThreadBadgeTitle(threadCount)}</span>
      <button
        type="button"
        className="flex items-center gap-1 hover:text-foreground transition-colors"
        onClick={() => setReviewThreadsVisible(!visible)}
      >
        {visible ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
        {visible
          ? translate('auto.components.diff.comments.reviewThreads.hideAction', 'Hide comments')
          : translate('auto.components.diff.comments.reviewThreads.showAction', 'Show comments')}
      </button>
    </div>
  )
}
