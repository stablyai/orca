import { KEEPS_FOCUS_ATTRIBUTE } from '@/lib/focus-keeping-press'
import { cn } from '@/lib/utils'
import { useDictationPillBox, type DictationPillAnchor } from './dictation-pill-anchor'

// Presses on the pill keep focus where the words are going.
const keepFocus = (event: React.MouseEvent): void => event.preventDefault()
const keepFocusProps = { [KEEPS_FOCUS_ATTRIBUTE]: '', onMouseDown: keepFocus }

/** The pill's floating container: over the anchor pane, or at the window's bottom centre without one. */
export function DictationPillShell({
  anchor,
  testId,
  className,
  children
}: {
  anchor: DictationPillAnchor | null
  testId: string
  className?: string
  children: React.ReactNode
}) {
  const box = useDictationPillBox(anchor)
  return (
    <div
      data-testid={testId}
      className={cn(
        'fixed z-50 flex h-10 -translate-x-1/2 items-center gap-2 rounded-full px-2 text-[13px]',
        'border border-border bg-popover/95 text-popover-foreground shadow-floating backdrop-blur',
        'transition-[opacity,translate] duration-180 ease-out starting:translate-y-1.5 starting:opacity-0 motion-reduce:transition-opacity',
        !box && 'bottom-12 left-1/2 w-[min(440px,calc(100vw-2rem))]',
        className
      )}
      style={box ? { left: box.left, bottom: box.bottom, width: box.width } : undefined}
      {...keepFocusProps}
    >
      {children}
    </div>
  )
}
