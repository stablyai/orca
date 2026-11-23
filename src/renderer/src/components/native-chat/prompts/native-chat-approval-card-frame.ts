import { cn } from '@/lib/class-names'

/** The approval card's wrapper classes for where it sits: the chat's own slot, a stacked card, or
 *  joined inside the worker dock, which draws the frame and scrolls. */
export function approvalCardFrameClasses({
  stacked,
  joined,
  quiet
}: {
  stacked: boolean
  joined: boolean
  quiet: boolean
}): { outer: string; gutter: string; column: string; card: string } {
  const fill = !stacked && 'h-full min-h-0 max-h-full'
  return {
    outer: joined ? '' : stacked ? 'bg-chat-pane' : 'min-h-0 shrink overflow-hidden bg-chat-pane',
    gutter: cn(
      'flex w-full',
      joined
        ? null
        : // Quiet: the transcript scroller's gutters too, which narrow panes show.
          quiet
          ? 'px-3 pt-2 pb-1 sm:px-4 scrollbar-sleek overflow-hidden [scrollbar-gutter:stable_both-edges]'
          : 'mx-auto max-w-(--chat-content-max-width) px-3 pt-2 pb-1 sm:px-4',
      fill
    ),
    // Quiet: laid out as the transcript column is, so the card's edges meet its rows' icon and time.
    column: cn(
      'flex w-full',
      quiet && !joined && 'mx-auto max-w-(--chat-content-max-width) px-[5px]',
      fill
    ),
    card: cn(
      'flex min-h-0 w-full flex-1 flex-col overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      joined
        ? 'gap-2 px-4 py-3 focus-visible:ring-inset'
        : quiet
          ? 'gap-1.5 rounded-lg border border-border bg-card px-2.5 pt-1.5 pb-2'
          : 'gap-2 rounded-lg border border-input bg-card px-4 py-3 shadow-xs'
    )
  }
}
