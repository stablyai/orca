import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, Ref, RefObject } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { isKeyboardOrVirtualFocus } from '@/lib/keyboard/keyboard-input-modality'

/** A 24px icon tool whose tooltip and accessible name are the same words. */
export function UsageLimitToolButton({
  label,
  disabled,
  busy,
  pressed,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  busy?: boolean
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="chat-tool"
          size="icon-xs"
          aria-label={label}
          // Why aria-disabled: a natively disabled button drops focus and can't show its tooltip.
          aria-disabled={disabled || undefined}
          aria-busy={busy || undefined}
          aria-pressed={pressed}
          onClick={disabled ? undefined : onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Where focus goes once a control that held it has left: the swapped-in controls, else More. */
export type UsageLimitPendingFocus = 'slot' | 'more' | null

/** Holds the swappable controls; asks for focus to move on when it leaves while it (or a menu it
 *  opened) had focus. */
export function UsageLimitFocusSlot({
  pendingFocus,
  children
}: {
  pendingFocus: RefObject<UsageLimitPendingFocus>
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // React focus events bubble through portals, so a focused account-menu item counts as inside.
  const ownsFocus = useRef(false)
  useLayoutEffect(() => {
    const element = ref.current
    return () => {
      if (ownsFocus.current || element?.contains(document.activeElement)) {
        pendingFocus.current = 'slot'
      }
    }
  }, [pendingFocus])
  return (
    <div
      ref={ref}
      className="flex shrink-0 items-center gap-0.5"
      onFocus={() => {
        ownsFocus.current = true
      }}
      onBlur={() => {
        ownsFocus.current = false
      }}
    >
      {children}
    </div>
  )
}

function focusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body
}

/** Focuses the first usable control in `slot`, else `fallback`, only if focus fell to nowhere. */
export function restoreUsageLimitFocus(
  slot: HTMLElement | null,
  fallback: HTMLElement | null
): void {
  const target =
    slot?.querySelector<HTMLElement>('button:not([disabled]):not([aria-disabled="true"])') ??
    fallback
  if (!target || !focusLost()) {
    return
  }
  target.focus()
  // Radix restores focus to a removed menu trigger after its own deferred work; re-apply only if
  // that left focus nowhere, never over focus the person has since moved.
  requestAnimationFrame(() => {
    if (focusLost() && target.isConnected) {
      target.focus()
    }
  })
}

export type UsageLimitMoreItem = {
  key: string
  label: string
  disabled?: boolean
  onSelect: () => void
}

export function UsageLimitMoreMenu({
  triggerRef,
  items
}: {
  triggerRef: Ref<HTMLButtonElement>
  items: readonly UsageLimitMoreItem[]
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('components.native-chat.usageLimitActions.more', 'More actions')
  const [menuOpen, setMenuOpen] = useState(false)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  return (
    <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      {/* The label would sit over the open menu it names. */}
      <Tooltip open={tooltipOpen && !menuOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="chat-tool"
              size="icon-xs"
              aria-label={label}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        // A pointer close leaves no keyboard ring on More; keyboard closes still return focus.
        onCloseAutoFocus={(event) => {
          if (!isKeyboardOrVirtualFocus()) {
            event.preventDefault()
          }
        }}
      >
        {items.map((item) => (
          <DropdownMenuItem key={item.key} disabled={item.disabled} onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
