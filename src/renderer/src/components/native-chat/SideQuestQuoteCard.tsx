import { useCallback, useId, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export type SideQuestQuoteCardProps = {
  sourceLabel: string
  text: string
  onRemove: () => void
}

export function SideQuestQuoteCard({
  sourceLabel,
  text,
  onRemove
}: SideQuestQuoteCardProps): React.JSX.Element {
  const contentId = useId()
  const [expandedText, setExpandedText] = useState<string | null>(null)
  const [clipped, setClipped] = useState(false)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const removeResizeListenerRef = useRef<(() => void) | null>(null)
  const expanded = expandedText === text

  const measureClipped = useCallback((element: HTMLElement) => {
    const nextClipped = element.scrollHeight > element.clientHeight + 1
    setClipped((current) => (current === nextClipped ? current : nextClipped))
  }, [])

  const handleTextRef = useCallback(
    (node: HTMLQuoteElement | null): void => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      removeResizeListenerRef.current?.()
      removeResizeListenerRef.current = null

      if (!node || expanded) {
        return
      }

      measureClipped(node)
      const updateClipped = () => measureClipped(node)
      if (typeof ResizeObserver === 'undefined') {
        window.addEventListener('resize', updateClipped)
        removeResizeListenerRef.current = () => window.removeEventListener('resize', updateClipped)
        return
      }

      // Why: rendered wrapping varies by composer width and platform font metrics,
      // so disclosure follows actual overflow instead of a character-count guess.
      const observer = new ResizeObserver(updateClipped)
      observer.observe(node)
      resizeObserverRef.current = observer
    },
    [expanded, measureClipped]
  )

  const contextLabel = translate(
    'components.native-chat.quoteCard.contextFrom',
    'Context from {{value0}}',
    { value0: sourceLabel }
  )
  const removeLabel = translate(
    'components.native-chat.quoteCard.remove',
    'Remove context from {{value0}}',
    { value0: sourceLabel }
  )

  return (
    <div
      data-slot="side-quest-quote-card"
      className="rounded-lg border border-border bg-muted/40 px-2.5 py-2"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words pt-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {contextLabel}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={removeLabel}
              onClick={onRemove}
              className="-mr-1 -mt-0.5 text-muted-foreground pointer-coarse:size-9"
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {removeLabel}
          </TooltipContent>
        </Tooltip>
      </div>

      <blockquote
        key={text}
        ref={handleTextRef}
        id={contentId}
        className={cn(
          'mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-foreground',
          !expanded && 'line-clamp-3'
        )}
      >
        {text}
      </blockquote>

      {clipped ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpandedText(expanded ? null : text)}
          className="-ml-2 mt-0.5 text-muted-foreground"
        >
          {expanded
            ? translate('components.native-chat.quoteCard.showLess', 'Show less')
            : translate('components.native-chat.quoteCard.showMore', 'Show more')}
          <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
        </Button>
      ) : null}
    </div>
  )
}
