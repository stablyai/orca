import { useRef, type ReactElement, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
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
  const content = useRef<HTMLDivElement>(null)
  const focusSearch = () =>
    content.current?.querySelector<HTMLInputElement>('[cmdk-input]:not(:disabled)')?.focus({
      preventScroll: true
    })
  const close = (returnFocus: 'row' | 'segment') => {
    onOpenChange(false)
    const target =
      returnFocus === 'row'
        ? trigger.current
        : trigger.current?.querySelector<HTMLButtonElement>('button')
    target?.focus()
  }
  return (
    <DropdownMenuSub open={open} onOpenChange={onOpenChange}>
      <DropdownMenuSubTrigger
        asChild
        hideChevron
        ref={trigger}
        variant="launch-row"
        disabled={disabled}
        onPointerMove={(event) => {
          event.preventDefault()
          const segment = event.currentTarget.querySelector('button')
          if (
            !disabled &&
            event.pointerType === 'mouse' &&
            event.target instanceof Node &&
            event.currentTarget.contains(event.target) &&
            !segment?.contains(event.target)
          ) {
            event.currentTarget.focus({ preventScroll: true })
          }
        }}
      >
        {renderAnchor(
          <Button
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
        sideOffset={4}
        collisionPadding={8}
        variant="picker"
        className="flex w-96 min-w-64 max-w-(--radix-dropdown-menu-content-available-width) max-h-(--radix-dropdown-menu-content-available-height) flex-col"
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
