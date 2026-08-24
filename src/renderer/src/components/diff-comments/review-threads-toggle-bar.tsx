import { Eye, EyeOff } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { reviewThreadBadgeTitle } from './review-thread-copy'
import { setReviewThreadsVisible } from './review-thread-visibility'

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
      <Button
        variant="ghost"
        size="xs"
        className="h-auto px-0 text-xs font-normal text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
        onClick={() => setReviewThreadsVisible(!visible)}
      >
        {visible ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
        {visible
          ? translate('auto.components.diff.comments.reviewThreads.hideAction', 'Hide comments')
          : translate('auto.components.diff.comments.reviewThreads.showAction', 'Show comments')}
      </Button>
    </div>
  )
}
