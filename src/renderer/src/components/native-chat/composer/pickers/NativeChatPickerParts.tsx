// The `@`, `/` and `$` menus' shared pieces: the portaled listbox, an option row and a status line.
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, offset, size } from '@floating-ui/dom'
import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'

export function PickerStatus({
  busy = false,
  className,
  children
}: {
  busy?: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn('flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground', className)}
    >
      {busy ? <LoadingSpinner className="size-3.5" /> : null}
      {children}
    </div>
  )
}

export function PickerListbox({
  id,
  children
}: {
  id: string
  children: React.ReactNode
}): React.JSX.Element {
  const marker = useRef<HTMLSpanElement>(null)
  const listbox = useRef<HTMLDivElement>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  // Inside the launch setup (a popover or the new-tab menu's submenu), take the menu layer those overlays use.
  const [inOverlay, setInOverlay] = useState(false)
  useLayoutEffect(() => {
    setContainer(marker.current?.closest<HTMLElement>('.native-chat-appearance') ?? document.body)
    setInOverlay(
      Boolean(
        marker.current?.closest(
          '[data-slot="popover-content"], [data-slot="dropdown-menu-sub-content"]'
        )
      )
    )
  }, [])
  useLayoutEffect(() => {
    const anchor = marker.current?.parentElement
    const floating = listbox.current
    if (!anchor || !floating) {
      return
    }
    // autoUpdate also follows moves with no resize or scroll, like dragging the floating panel.
    return autoUpdate(anchor, floating, () => {
      void computePosition(anchor, floating, {
        strategy: 'fixed',
        placement: 'top-start',
        middleware: [
          offset(4),
          size({
            padding: 8,
            apply: ({ rects, availableHeight }) => {
              floating.style.width = `${rects.reference.width}px`
              floating.style.maxHeight = `min(calc(var(--spacing) * 72), ${Math.max(0, availableHeight)}px)`
            }
          })
        ]
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`
        floating.style.top = `${y}px`
      })
    })
  }, [container])
  return (
    <>
      <span ref={marker} />
      {container &&
        createPortal(
          <div
            ref={listbox}
            id={id}
            role="listbox"
            data-focus-behavior="composer-suggestions"
            className={`scrollbar-sleek fixed left-0 top-0 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-floating ${inOverlay ? 'z-[70]' : 'z-50'}`}
          >
            {children}
          </div>,
          container
        )}
    </>
  )
}

export function PickerOptionButton({
  id,
  selected,
  activeItemRef,
  onChoose,
  title,
  onPointerEnter,
  className,
  children
}: {
  id: string
  selected: boolean
  activeItemRef: React.MutableRefObject<HTMLButtonElement | null>
  onChoose: () => void
  title?: string
  onPointerEnter?: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      id={id}
      title={title}
      onPointerEnter={onPointerEnter}
      ref={selected ? activeItemRef : null}
      role="option"
      aria-selected={selected}
      type="button"
      onPointerDown={(event) => {
        // Accept before focus transfer because the textarea owns query and caret state.
        event.preventDefault()
        if (event.button === 0) {
          onChoose()
        }
      }}
      className={cn(
        'flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground hover:[--muted-foreground:var(--accent-foreground)]',
        selected &&
          'border-border bg-accent text-accent-foreground [--muted-foreground:var(--accent-foreground)]',
        className
      )}
    >
      {children}
    </button>
  )
}
