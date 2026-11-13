import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { autoUpdate } from '@floating-ui/dom'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useSubmenuOpensLeft } from './use-submenu-opens-left'

const SETUP_SUBMENU_WIDTH_PX = 416
const SETUP_SUBMENU_COLLISION_PADDING_PX = 8

export function AgentLaunchSetupSubmenu({
  open,
  onOpenChange,
  renderAnchor,
  disabled,
  label,
  returnFocus,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  renderAnchor: (trigger: ReactElement) => ReactElement
  disabled?: boolean
  label: string
  /** Caller owns keyboard focus (a search input): hover-open leaves it there and closing returns it. */
  returnFocus?: () => void
  children: (focusPanel: boolean) => ReactNode
}) {
  const trigger = useRef<HTMLDivElement>(null)
  const segment = useRef<HTMLButtonElement>(null)
  const [focusPanel, setFocusPanel] = useState(true)
  const content = useRef<HTMLDivElement>(null)
  const [sideOffset, setSideOffset] = useState(4)
  const opensLeft = useSubmenuOpensLeft(trigger, {
    submenuWidth: SETUP_SUBMENU_WIDTH_PX,
    collisionPadding: SETUP_SUBMENU_COLLISION_PADDING_PX
  })
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const anchor = trigger.current
    if (!anchor) {
      return
    }
    const measure = () => {
      const rect = anchor.getBoundingClientRect()
      const space = Math.max(
        rect.left - SETUP_SUBMENU_COLLISION_PADDING_PX,
        document.documentElement.clientWidth - rect.right - SETUP_SUBMENU_COLLISION_PADDING_PX
      )
      setSideOffset(Math.min(4, space - SETUP_SUBMENU_WIDTH_PX))
    }
    const stop = autoUpdate(anchor, null, measure, { animationFrame: false })
    const observer = new ResizeObserver(measure)
    observer.observe(document.documentElement)
    return () => {
      stop()
      observer.disconnect()
    }
  }, [open])
  const wasOpen = useRef(open)
  useLayoutEffect(() => {
    const closed = wasOpen.current && !open
    wasOpen.current = open
    const active = document.activeElement
    // Why: a close the caller drives (hover grace, another row) unmounts a focused panel; keep typing in the caller's input.
    if (
      closed &&
      returnFocus &&
      (!active || active === document.body || content.current?.contains(active))
    ) {
      returnFocus()
    }
  }, [open, returnFocus])
  const segmentRelease = useRef(false)
  const focusSearch = () =>
    content.current?.querySelector<HTMLInputElement>('[cmdk-input]:not(:disabled)')?.focus({
      preventScroll: true
    })
  const openExplicitly = () => {
    setFocusPanel(true)
    onOpenChange(true)
    focusSearch()
  }
  const close = (target: 'row' | 'segment') => {
    onOpenChange(false)
    if (returnFocus) {
      returnFocus()
    } else {
      ;(target === 'row' ? trigger.current : segment.current)?.focus()
    }
  }
  return (
    <DropdownMenuSub
      open={open}
      onOpenChange={(next) => {
        // Opening is explicit; Radix still owns pointer grace, focus, and dismissal.
        if (!next) {
          onOpenChange(false)
        }
      }}
    >
      <DropdownMenuSubTrigger
        asChild
        hideChevron
        ref={trigger}
        variant="launch-row"
        className={opensLeft ? 'flex-row-reverse' : undefined}
        disabled={disabled}
        onPointerMove={(event) => {
          if (event.target instanceof Node && segment.current?.contains(event.target)) {
            event.preventDefault()
          }
        }}
        onPointerDownCapture={() => {
          segmentRelease.current = false
        }}
        onPointerUpCapture={(event) => {
          segmentRelease.current =
            event.target instanceof Node && !!segment.current?.contains(event.target)
        }}
        onClickCapture={(event) => {
          if (segmentRelease.current && event.target === event.currentTarget) {
            event.preventDefault()
            event.stopPropagation()
          }
          segmentRelease.current = false
        }}
        onKeyDownCapture={() => {
          segmentRelease.current = false
        }}
        onKeyDown={(event) => {
          if (!disabled && event.key === 'ArrowRight') {
            event.preventDefault()
            openExplicitly()
          }
        }}
      >
        {renderAnchor(
          <Button
            ref={segment}
            variant={opensLeft ? 'menu-segment-start' : 'menu-segment'}
            size="icon"
            // Why: stretch to the row so compact omnibox rows keep their height.
            className="h-auto min-h-6 self-stretch"
            type="button"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            // Why move, not enter: like Radix's sub-trigger, rows shifting under a resting pointer must not open setup.
            onPointerMove={(event) => {
              if (!disabled && event.pointerType === 'mouse' && !open) {
                setFocusPanel(!returnFocus)
                onOpenChange(true)
              }
            }}
            onPointerUp={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              trigger.current?.focus()
              openExplicitly()
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'ArrowRight') {
                event.preventDefault()
                event.currentTarget.click()
              } else if (['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                trigger.current?.focus()
                if (event.key !== 'ArrowLeft') {
                  trigger.current?.dispatchEvent(
                    new window.KeyboardEvent('keydown', { key: event.key, bubbles: true })
                  )
                }
              }
            }}
          >
            {opensLeft ? (
              <ChevronLeft className="size-3.5 text-current" />
            ) : (
              <ChevronRight className="size-3.5 text-current" />
            )}
          </Button>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        ref={content}
        aria-label={label}
        aria-labelledby={undefined}
        sideOffset={sideOffset}
        collisionPadding={SETUP_SUBMENU_COLLISION_PADDING_PX}
        variant="picker"
        className="flex w-104 min-w-0 max-w-[calc(100vw-1rem)] max-h-(--radix-dropdown-menu-content-available-height) flex-col"
        onFocusCapture={(event) => {
          if (event.target !== event.currentTarget) {
            return
          }
          // Why: after a keystroke Radix autofocuses even a hover-opened panel (rows can shift under a resting pointer).
          if (!focusPanel && returnFocus) {
            returnFocus()
          } else {
            focusSearch()
          }
        }}
        onPointerMove={() => {
          if (!focusPanel) {
            setFocusPanel(true)
          }
        }}
        onClick={(event) => event.stopPropagation()}
        onFocusOutside={(event) => {
          const row = trigger.current?.closest('[data-agent-launch-row]')
          const menu = trigger.current?.closest('[data-slot="dropdown-menu-content"]')
          if (returnFocus && event.target === menu) {
            // Radix focuses the root menu when the pointer leaves the row; keep typing where it was.
            const previous = event.detail.originalEvent.relatedTarget
            if (previous instanceof HTMLElement && content.current?.contains(previous)) {
              previous.focus({ preventScroll: true })
            } else {
              returnFocus()
            }
          }
          // Nested option menus and pointer grace may move focus outside this portal.
          if (
            !(
              event.target instanceof Element &&
              event.target.closest('[role="menuitem"]') &&
              menu?.contains(event.target) &&
              !row?.contains(event.target)
            )
          ) {
            event.preventDefault()
          }
        }}
        onKeyDownCapture={(event) => {
          const target = event.target
          const emptySearch =
            target instanceof HTMLInputElement && target.matches('[cmdk-input]') && !target.value
          const editing =
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
          if (
            event.key === 'ArrowLeft' &&
            !event.nativeEvent.isComposing &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            target instanceof Element &&
            target.closest('[role="menu"]') === event.currentTarget &&
            (emptySearch || !editing)
          ) {
            event.preventDefault()
            event.stopPropagation()
            close('row')
          }
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          if (!content.current?.querySelector('[contenteditable][aria-expanded="true"]')) {
            close('segment')
          }
        }}
      >
        {children(focusPanel)}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
