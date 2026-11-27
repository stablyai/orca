import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

// Why: same shades as the checks panel skeleton (#47812); bg-muted is the sidebar's own shade in light theme.
const bar = 'block shrink-0 rounded bg-muted-foreground/15'
const cardBar = 'block shrink-0 rounded bg-muted-foreground/20 dark:bg-muted-foreground/15'
// Why: a fast read never flashes bars; reduced motion skips the fade and shows them at once.
const fade = 'animate-in fade-in-0 fill-mode-backwards delay-150 motion-reduce:animate-none'

/** Lines inside the description card's body padding; each row is one line of the loaded 14px text. */
export function DescriptionBodyLoading(): React.JSX.Element {
  return (
    <div aria-hidden="true" className={fade}>
      {['w-4/5', 'w-3/5', 'w-2/5'].map((width) => (
        <div key={width} className="flex h-[1lh] items-center">
          <span className={cn(cardBar, 'h-2.5', width)} />
        </div>
      ))}
    </div>
  )
}

/** Audience filter strip at the loaded strip's height (h-8 tabs inside p-0.5). */
export function CommentAudienceFilterLoading(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'grid grid-cols-3 rounded-lg border border-border/50 bg-background p-0.5',
        fade
      )}
    >
      {['w-8', 'w-12', 'w-9'].map((width) => (
        <div key={width} className="flex h-8 items-center justify-center">
          <span className={cn(bar, 'h-2', width)} />
        </div>
      ))}
    </div>
  )
}

/** Two comment cards with the loaded card's header row and body padding. */
export function CommentCardsLoading(): React.JSX.Element {
  return (
    <div aria-hidden="true" className={cn('flex min-w-0 flex-col gap-3', fade)}>
      {['w-3/5', 'w-2/5'].map((width) => (
        <div
          key={width}
          className="min-w-0 overflow-hidden rounded-lg border border-border/40 bg-card shadow-xs"
        >
          <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
            <span className={cn(cardBar, 'size-5 rounded-full')} />
            <span className={cn(cardBar, 'h-2.5 w-20 max-w-1/2')} />
            {/* Why: reserves the reply button's 28px so the header keeps its loaded height. */}
            <span className="ml-auto size-7 shrink-0" />
          </div>
          <div className="min-w-0 px-3 py-2 text-[13px] leading-relaxed">
            <div className="flex h-[1lh] items-center">
              <span className={cn(cardBar, 'h-2.5 w-4/5')} />
            </div>
            <div className="flex h-[1lh] items-center">
              <span className={cn(cardBar, 'h-2.5', width)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The comment composer, disabled, so it is already in place when the details land. */
export function CommentComposerLoading({ className }: { className?: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div aria-hidden="true" className={cn('relative', className)}>
      <div className="relative flex min-h-20 w-full min-w-0 flex-1 items-stretch">
        <textarea
          disabled
          tabIndex={-1}
          rows={4}
          placeholder={t('auto.components.PullRequestPage.d2030fc8cd', 'Add a comment…')}
          className="block h-20 min-h-20 w-full resize-none overflow-hidden rounded-md border border-input bg-card px-3 py-2 pr-12 pb-12 text-[13px] leading-5 placeholder:text-muted-foreground disabled:cursor-default"
        />
      </div>
      <Button
        type="button"
        size="icon-sm"
        disabled
        tabIndex={-1}
        className="absolute right-3 bottom-3"
      >
        <Send className="size-4" />
      </Button>
    </div>
  )
}
