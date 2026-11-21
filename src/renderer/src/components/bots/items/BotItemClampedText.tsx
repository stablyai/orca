// Markdown cut at a height with Show more: the item's description and its long comments.
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotItemMarkdown } from './BotItemMarkdown'

export function BotItemClampedText({
  text,
  clampClassName,
  fade = false,
  className,
  render
}: {
  text: string
  /** The cut's max height. */
  clampClassName: string
  /** Fade the last lines out once cut. */
  fade?: boolean
  className?: string
  /** Draws the text in place of the item's Markdown (a question's heading). */
  render?: (text: string) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const body = useRef<HTMLDivElement | null>(null)
  const id = useId()
  // Remeasured when the pane narrows or the text's own height changes (an image loads), not only
  // when the text does, so a cut never hides text without Show more.
  useEffect(() => {
    const node = body.current
    if (!node || open) {
      return
    }
    const measure = (): void => setClamped(node.scrollHeight > node.clientHeight + 1)
    measure()
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
                  '[mask-image:linear-gradient(to_bottom,#000_calc(100%-44px),transparent)]'
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
          className="text-xs font-medium text-foreground hover:underline"
          onClick={() => setOpen(!open)}
        >
          {open
            ? t('bots.items.view.showLess', 'Show less')
            : t('bots.items.view.showMore', 'Show more')}
        </button>
      ) : null}
    </div>
  )
}
