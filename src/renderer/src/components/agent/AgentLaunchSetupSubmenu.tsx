import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { autoUpdate } from '@floating-ui/dom'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'

export function AgentLaunchSetupSubmenu({
  open,
  onOpenChange,
  renderAnchor,
  disabled,
  label,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  renderAnchor: (trigger: ReactElement) => ReactElement
  disabled?: boolean
  label: string
  children: ReactNode
}) {
  const trigger = useRef<HTMLDivElement>(null)
  const segment = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [sideOffset, setSideOffset] = useState(4)
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
      const space = Math.max(rect.left - 8, document.documentElement.clientWidth - rect.right - 8)
      setSideOffset(Math.min(4, space - 416))
    }
    const stop = autoUpdate(anchor, null, measure, { animationFrame: false })
    const observer = new ResizeObserver(measure)
    observer.observe(document.documentElement)
    return () => {
      stop()
      observer.disconnect()
    }
  }, [open])
  const segmentRelease = useRef(false)
  const focusSearch = () =>
    content.current?.querySelector<HTMLInputElement>('[cmdk-input]:not(:disabled)')?.focus({
      preventScroll: true
    })
  const close = (returnFocus: 'row' | 'segment') => {
    onOpenChange(false)
    const target = returnFocus === 'row' ? trigger.current : segment.current
    target?.focus()
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
            onOpenChange(true)
            focusSearch()
          }
        }}
      >
        {renderAnchor(
          <Button
            ref={segment}
            variant="menu-segment"
            size="icon-sm"
            type="button"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onPointerEnter={(event) => {
              if (!disabled && event.pointerType === 'mouse') {
                onOpenChange(true)
              }
            }}
            onPointerUp={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              trigger.current?.focus()
              onOpenChange(true)
              focusSearch()
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
            <ChevronRight className="size-3.5 text-current" />
          </Button>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        ref={content}
        aria-label={label}
        aria-labelledby={undefined}
        sideOffset={sideOffset}
        collisionPadding={8}
        variant="picker"
        className="flex w-104 min-w-0 max-w-[calc(100vw-1rem)] max-h-(--radix-dropdown-menu-content-available-height) flex-col"
        onFocusCapture={(event) => {
          if (event.target === event.currentTarget) {
            focusSearch()
          }
        }}
        onClick={(event) => event.stopPropagation()}
        onFocusOutside={(event) => {
          const row = trigger.current?.closest('[data-agent-launch-row]')
          const menu = trigger.current?.closest('[data-slot="dropdown-menu-content"]')
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
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
