import { useRef, type ReactElement, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
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
  const close = () => {
    onOpenChange(false)
    trigger.current?.querySelector<HTMLButtonElement>('button')?.focus()
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
          if (event.target instanceof Node && !event.currentTarget.contains(event.target)) {
            event.preventDefault()
          }
        }}
      >
        {renderAnchor(
          <button
            type="button"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            className="-my-1.5 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center"
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
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
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
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </button>
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
          if (
            event.key === 'ArrowLeft' &&
            !(
              event.target instanceof HTMLInputElement ||
              event.target instanceof HTMLTextAreaElement ||
              (event.target instanceof HTMLElement && event.target.isContentEditable)
            )
          ) {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          if (!content.current?.querySelector('[contenteditable][aria-expanded="true"]')) {
            close()
          }
        }}
      >
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
