// The rail itself: a column of ticks down the right edge of the transcript, one
// per user message, with a hover panel that previews them and jumps on click.

import { memo, useEffect, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import type { NativeChatMessageRailState } from './use-native-chat-message-rail'

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
/** Nominal line height for line-mode wheel deltas, which arrive as ~3 per notch. */
const WHEEL_LINE_PX = 16

function railItemLabel(item: NativeChatRailItem): string {
  if (item.text.length > 0) {
    return item.text
  }
  return item.hasImages
    ? translate('components.native-chat.railImageMessage', 'Image attachment')
    : translate('components.native-chat.railEmptyMessage', 'Message')
}

export const NativeChatMessageRail = memo(function NativeChatMessageRail({
  rail,
  scrollRef,
  onSelect
}: {
  rail: NativeChatMessageRailState
  scrollRef: React.RefObject<HTMLDivElement | null>
  onSelect: (item: NativeChatRailItem) => void
}): React.JSX.Element | null {
  // Hover preserves focus; activation enters the focus-managed prompt picker.
  const [mode, setMode] = useState<'hover' | 'interactive' | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef(false)
  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
    }
    closeTimer.current = null
  }
  const leavePreview = (): void => {
    cancelClose()
    if (mode === 'hover') {
      closeTimer.current = setTimeout(() => setMode(null), 120)
    }
  }
  useEffect(
    () => () => {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current)
      }
    },
    []
  )

  if (!rail.visible) {
    return null
  }

  return (
    <Popover
      open={mode !== null}
      onOpenChange={(open) => {
        cancelClose()
        if (open) {
          restoreFocus.current = true
        }
        setMode(open ? 'interactive' : null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-native-chat-rail
          aria-label={translate('components.native-chat.railLabel', 'Your messages')}
          onPointerEnter={(event) => {
            if (event.pointerType === 'touch') {
              return
            }
            cancelClose()
            if (mode === null) {
              restoreFocus.current = false
            }
            setMode((current) => current ?? 'hover')
          }}
          onPointerLeave={leavePreview}
          onClick={(event) => {
            cancelClose()
            if (mode === 'hover') {
              event.preventDefault()
              restoreFocus.current = true
              setMode('interactive')
              contentRef.current?.querySelector('button')?.focus()
            }
          }}
          // The rail overlays the transcript without being inside it, so a wheel
          // here would otherwise land on nothing and freeze the scroll. Deltas
          // arrive in lines or pages on some platforms, not only in pixels.
          onWheel={(event) => {
            const element = scrollRef.current
            if (!element) {
              return
            }
            const scale =
              event.deltaMode === WHEEL_DELTA_LINE
                ? WHEEL_LINE_PX
                : event.deltaMode === WHEEL_DELTA_PAGE
                  ? element.clientHeight
                  : 1
            element.scrollTop += event.deltaY * scale
          }}
          className="group/rail absolute inset-y-0 right-[14px] z-10 flex w-4 cursor-default flex-col items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {rail.ticks.map((item) => (
            <span
              key={item.id}
              aria-hidden
              className={cn(
                'h-[3px] shrink-0 rounded-full transition-all duration-150',
                item.id === rail.activeId
                  ? 'w-5 bg-foreground/30 group-hover/rail:bg-foreground/70'
                  : 'w-3 bg-foreground/10 group-hover/rail:bg-foreground/25'
              )}
            />
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side="left"
        align="center"
        aria-label={translate('components.native-chat.railLabel', 'Your messages')}
        className="w-72 p-1"
        onPointerEnter={cancelClose}
        onPointerLeave={leavePreview}
        onFocusCapture={() => {
          cancelClose()
          restoreFocus.current = true
          setMode('interactive')
        }}
        onOpenAutoFocus={(event) => {
          if (mode === 'hover') {
            event.preventDefault()
          }
        }}
        onCloseAutoFocus={(event) => {
          if (!restoreFocus.current) {
            event.preventDefault()
          }
        }}
      >
        <ul className="scrollbar-sleek max-h-64 overflow-y-auto overflow-x-hidden">
          {rail.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(item)
                  setMode(null)
                }}
                aria-current={item.id === rail.activeId ? 'true' : undefined}
                data-current={item.id === rail.activeId}
                className={cn(
                  'flex w-full cursor-pointer rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  item.id === rail.activeId && 'bg-accent'
                )}
              >
                <span
                  className={cn(
                    'line-clamp-2 text-xs leading-snug',
                    item.id === rail.activeId ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {railItemLabel(item)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
})
