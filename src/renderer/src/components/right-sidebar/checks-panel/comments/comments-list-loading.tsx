import { cn } from '@/lib/class-names'
import type { PRCommentPresentationClasses } from './pr-comment-presentation'

const bar = 'block rounded bg-muted-foreground/15'
const cardBar = 'block rounded bg-muted-foreground/20 dark:bg-muted-foreground/15'
const fade = 'animate-in fade-in-0 fill-mode-backwards delay-150 motion-reduce:animate-none'

export function CommentsAudienceLoading({
  presentation
}: {
  presentation: PRCommentPresentationClasses
}): React.JSX.Element {
  return (
    <div aria-hidden="true" className={cn(presentation.audienceTabs, fade)}>
      {['w-7', 'w-12', 'w-8'].map((width) => (
        <div key={width} className={presentation.audienceTab}>
          <span className={cn(bar, 'h-2', width)} />
        </div>
      ))}
    </div>
  )
}

export function CommentsListLoading({
  presentation
}: {
  presentation: PRCommentPresentationClasses
}): React.JSX.Element {
  return (
    <div aria-hidden="true" className={cn(presentation.list, fade)}>
      {['w-3/5', 'w-2/5'].map((width) => (
        <div key={width} className={cn(presentation.group, presentation.groupStandalone)}>
          <div className={presentation.commentRow}>
            <div className={presentation.commentHeader}>
              <div className={presentation.commentHeaderPrimary}>
                <span className={cn(presentation.avatar, cardBar, 'shrink-0 rounded-full')} />
                <span className={cn(cardBar, 'h-2.5 w-20 max-w-1/2')} />
              </div>
            </div>
            <div className={presentation.commentBody}>
              <div className="flex h-5 items-center">
                <span className={cn(cardBar, 'h-2.5 w-4/5')} />
              </div>
              <div className="flex h-5 items-center">
                <span className={cn(cardBar, 'h-2.5', width)} />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
