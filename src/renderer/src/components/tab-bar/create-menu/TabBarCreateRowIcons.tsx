import React from 'react'
import { cn } from '@/lib/class-names'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { formatShortcutKeyComboDetails } from '@/lib/keyboard/useShortcutLabel'
import { useAppStore } from '@/store/index'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TabStripScrollIndicator } from '../strip/TabStripScrollIndicator'
import { getTabStripScrollMaskClassName } from '../strip/tab-strip-scroll-metrics'
import type { useCreateRowScroller } from './use-create-row-scroller'

type CreateRowScroller = ReturnType<typeof useCreateRowScroller>
import type { TabBarCreateRowItem } from './tab-bar-create-row-item'
import { isPressedPointer } from './use-create-row-hover-tooltip'

export const CREATE_ROW_HIGHLIGHT_CLASS = 'bg-black/8 text-foreground dark:bg-white/14'

/** The create row's scrolling strip of icon buttons, each labelled by a tooltip. */
export function TabBarCreateRowIcons({
  items,
  highlightedIndex,
  tooltipIndex,
  overflow,
  scrollerRef,
  attachScroller,
  onEscape,
  onHover,
  onPress,
  onRun
}: {
  items: readonly TabBarCreateRowItem[]
  highlightedIndex: number | null
  tooltipIndex: number | null
  overflow: CreateRowScroller['overflow']
  scrollerRef: CreateRowScroller['scrollerRef']
  attachScroller: CreateRowScroller['attachScroller']
  /** Controlled tooltips sit above the menu and take Escape first; it must still close the menu. */
  onEscape: () => void
  onHover: (index: number | null, pressed?: boolean) => void
  onPress: () => void
  onRun: (item: TabBarCreateRowItem) => void
}): React.JSX.Element {
  const keybindings = useAppStore((state) => state.keybindings)
  return (
    <div
      // Why: only the gear opens the customizer; the strip (icons, gaps, scroll rail) never does.
      className={cn(
        'group/tab-strip relative flex min-w-0 flex-1',
        // A lane under the icons so the scroll rail never sits on them.
        overflow.hasOverflow && 'pb-1.5'
      )}
      onPointerMove={(event) => event.preventDefault()}
      onClick={(event) => event.preventDefault()}
    >
      <div
        ref={attachScroller}
        className={cn(
          'flex min-w-0 flex-1 gap-0.5 overflow-x-auto overflow-y-hidden scrollbar-none',
          getTabStripScrollMaskClassName(overflow)
        )}
      >
        {items.map((item, index) => {
          const highlighted = index === highlightedIndex
          const [shortcut] = item.actionId
            ? formatShortcutKeyComboDetails(item.actionId, keybindings)
            : []
          return (
            <Tooltip key={item.id} open={index === tooltipIndex}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={item.label}
                  data-create-row-item={item.id}
                  className={cn(
                    'flex h-7 w-9 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground outline-hidden',
                    highlighted && CREATE_ROW_HIGHLIGHT_CLASS
                  )}
                  // Why move, not enter: scrolling slides icons under a resting cursor without a real hover.
                  onPointerMove={(event) => onHover(index, isPressedPointer(event))}
                  onPointerLeave={() => onHover(null)}
                  onPointerDown={onPress}
                  onClick={() => onRun(item)}
                >
                  {item.icon}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6} onEscapeKeyDown={onEscape}>
                <span className="flex items-center gap-2">
                  {item.label}
                  {shortcut ? (
                    <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
                  ) : null}
                </span>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <TabStripScrollIndicator
        hasOverflow={overflow.hasOverflow}
        scrollContainerRef={scrollerRef}
      />
    </div>
  )
}
