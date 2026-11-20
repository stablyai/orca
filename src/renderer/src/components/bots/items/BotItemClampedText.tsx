// Markdown cut at a height with Show more: the item's description and its long comments. A waiting
// question's words cut between whole blocks instead (`blockFold`), so the fold never stops mid-line.
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotItemMarkdown } from './BotItemMarkdown'

const LINE = 19
const FOLD_LINES = 8

/** Where a block fold cuts: after the last paragraph or list item ending within 8 lines (one of grace),
 *  else at 8 lines; null when at most two more lines would hide. */
function blockFoldHeight(node: HTMLElement): number | null {
  if (node.scrollHeight <= (FOLD_LINES + 2) * LINE) {
    return null
  }
  const top = node.getBoundingClientRect().top
  const ends = [...node.querySelectorAll('p, li')]
    .map((block) => Math.ceil(block.getBoundingClientRect().bottom - top))
    .filter((bottom) => bottom <= (FOLD_LINES + 1) * LINE)
  return ends.length > 0 ? Math.max(...ends) : FOLD_LINES * LINE
}

export function BotItemClampedText({
  text,
  clampClassName,
  fade = false,
  blockFold = false,
  className,
  render
}: {
  text: string
  /** The cut's max height; unused with `blockFold`. */
  clampClassName?: string
  /** Cut after the last whole paragraph or list item within about 8 lines, fading its last line, with
   *  a muted Show more and chevron under it. */
  blockFold?: boolean
  /** Fade the last lines out once cut. */
  fade?: boolean
  className?: string
  /** Draws the text in place of the item's Markdown (a question's heading). */
  render?: (text: string) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const [foldAt, setFoldAt] = useState<number | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const id = useId()
  // Remeasured when the pane narrows or the text's own height changes (an image loads), not only
  // when the text does, so a cut never hides text without Show more.
  useEffect(() => {
    const node = body.current
    if (!node || open) {
      return
    }
    const measure = (): void => {
      if (blockFold) {
        const height = blockFoldHeight(node)
        setFoldAt(height)
        setClamped(height !== null)
        return
      }
      setClamped(node.scrollHeight > node.clientHeight + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (node.firstElementChild) {
      observer.observe(node.firstElementChild)
    }
    return () => observer.disconnect()
  }, [text, open, blockFold])
  return (
    <div className={className}>
      <div
        ref={body}
        id={id}
        style={!open && blockFold && foldAt !== null ? { maxHeight: foldAt } : undefined}
        className={
          open
            ? undefined
            : cn(
                'overflow-hidden',
                // Room for list markers, which hang left of the text, inside the clip and fade.
                blockFold && '-ml-4 pl-4',
                !blockFold && clampClassName,
                fade &&
                  clamped &&
                  '[mask-image:linear-gradient(to_bottom,#000_calc(100%-44px),transparent)]',
                // A block fold ends on a whole line, so only that line fades.
                blockFold &&
                  clamped &&
                  '[mask-image:linear-gradient(to_bottom,#000_calc(100%-19px),transparent)]'
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
            blockFold
              ? 'mt-1 flex items-center gap-0.5 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'
              : 'text-xs font-medium text-foreground hover:underline'
          }
          onClick={() => setOpen(!open)}
        >
          {open
            ? t('bots.items.view.showLess', 'Show less')
            : t('bots.items.view.showMore', 'Show more')}
          {blockFold ? (
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
