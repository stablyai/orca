// The way back out of a transcript the reader has scrolled into: to the latest
// message, or to the start of the conversation.
//
// Both stay mounted so they can fade rather than pop, and a hidden one is inert
// and hidden from assistive tech, so it can be neither clicked, tabbed to nor read.

import { useLayoutEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { useNativeChatRailHistoryJump } from './use-native-chat-rail-history-jump'

const JUMP_BUTTON_CLASS =
  'pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-border bg-popover text-xs font-medium text-popover-foreground shadow-floating transition-[opacity,translate] duration-150 ease-out hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none data-[shown=false]:pointer-events-none data-[shown=false]:translate-y-1 data-[shown=false]:opacity-0'

/** Keeps focus where the reader was typing: a pointer press never moves it here. */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault()
}

/** A keyboard press that hides the focused button hands focus to the transcript, not the page. */
function useHandBackFocus(visible: boolean, transcriptRef: React.RefObject<HTMLElement | null>) {
  const ref = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (!visible && ref.current !== null && ref.current === document.activeElement) {
      transcriptRef.current?.focus({ preventScroll: true })
    }
  }, [transcriptRef, visible])
  return ref
}

export function NativeChatJumpControls({
  showLatest,
  startOutOfView,
  historyJump,
  onLatest,
  transcriptRef
}: {
  showLatest: boolean
  /** Older history is still unloaded, or the loaded top is more than a screen away. */
  startOutOfView: boolean
  historyJump: Pick<
    ReturnType<typeof useNativeChatRailHistoryJump>,
    'startPending' | 'startFromBeginning'
  >
  onLatest: () => void
  transcriptRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  // Offered only beside the way back down, so a reader following the end sees neither.
  const showTop = showLatest && startOutOfView
  const latestRef = useHandBackFocus(showLatest, transcriptRef)
  const topRef = useHandBackFocus(showTop, transcriptRef)
  const topPending = historyJump.startPending
  const latestLabel = translate('components.native-chat.jumpToLatest', 'Jump to latest')
  const topLabel = translate('components.native-chat.jumpToTop', 'Jump to top')
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={topRef}
            type="button"
            aria-label={topLabel}
            aria-busy={topPending || undefined}
            data-shown={showTop}
            inert={!showTop}
            aria-hidden={!showTop || undefined}
            onMouseDown={keepFocus}
            onClick={historyJump.startFromBeginning}
            className={cn(JUMP_BUTTON_CLASS, 'w-8 justify-center')}
          >
            {topPending ? (
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <ArrowUp className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {topLabel}
        </TooltipContent>
      </Tooltip>
      <button
        ref={latestRef}
        type="button"
        data-shown={showLatest}
        inert={!showLatest}
        aria-hidden={!showLatest || undefined}
        onMouseDown={keepFocus}
        onClick={onLatest}
        className={cn(JUMP_BUTTON_CLASS, 'px-3')}
      >
        <ArrowDown className="size-3.5" />
        <span>{latestLabel}</span>
      </button>
    </div>
  )
}
