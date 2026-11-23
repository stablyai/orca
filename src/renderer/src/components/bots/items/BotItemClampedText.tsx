// Markdown cut at a height with Show more: the item's description and its long comments.
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotItemMarkdown } from './BotItemMarkdown'

export function BotItemClampedText({
  text,
  clampClassName,
  fade = false,
  quietToggle = false,
  startOpen = false,
  className,
  render
}: {
  text: string
  /** The cut's max height. */
  clampClassName: string
  /** Show more as a muted link with a chevron, for a body with more of the comment under it. */
  quietToggle?: boolean
  /** Fade the last lines out once cut. */
  fade?: boolean
  /** Shown whole from the start where it's cut; Show less still folds it. */
  startOpen?: boolean
  className?: string
  /** Draws the text in place of the item's Markdown (a question's heading). */
  render?: (text: string) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const opening = useRef(startOpen)
  const body = useRef<HTMLDivElement | null>(null)
  const id = useId()
  // Remeasured when the pane narrows or the text's own height changes (an image loads), not only
  // when the text does, so a cut never hides text without Show more. Measured before paint, so text
  // that starts open is never drawn cut first, and only text that is cut gets Show less.
  useLayoutEffect(() => {
    const node = body.current
    if (!node || open) {
      return
    }
    const measure = (): void => setClamped(node.scrollHeight > node.clientHeight + 1)
    measure()
    if (opening.current) {
      opening.current = false
      if (node.scrollHeight > node.clientHeight + 1) {
        setOpen(true)
        return
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (node.firstElementChild) {
      observer.observe(node.firstElementChild)
    }
    return () => observer.disconnect()
  }, [text, open])
  return (
    <div className={className}>
      <div
        ref={body}
        id={id}
        className={
          open
            ? undefined
            : cn(
                'overflow-hidden',
                clampClassName,
                fade &&
                  clamped &&
                  '[mask-image:linear-gradient(to_bottom,#000_calc(100%-44px),transparent)]',
                // List markers hang left of the text: room for them inside the clip and mask.
                quietToggle && '-ml-4 pl-4'
              )
        }
      >
        {render ? render(text) : <BotItemMarkdown text={text} />}
      </div>
      {clamped || open ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          className={
            quietToggle
              ? 'mt-1 flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring'
              : 'text-xs font-medium text-foreground hover:underline'
          }
          onClick={() => setOpen(!open)}
        >
          {open
            ? t('bots.items.view.showLess', 'Show less')
            : t('bots.items.view.showMore', 'Show more')}
          {quietToggle ? (
            <ChevronDown
              className={cn(
                'size-3 transition-transform motion-reduce:transition-none',
                open && 'rotate-180'
              )}
            />
          ) : null}
        </button>
      ) : null}
    </div>
  )
}
