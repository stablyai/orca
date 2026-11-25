// "Show N older" under a bot's chats in the sidebar: the settled chats a day untouched, folded. The
// toggle stays where it is when opened, with the older rows listed after it as its siblings, so "Hide
// older" never moves under the pointer; hiding them with focus on one of them moves focus to the toggle.
import type React from 'react'
import { useLayoutEffect, useRef } from 'react'
import { useTranslate } from '@/i18n/use-translate'

export function BotSidebarOlderToggle({
  count,
  open,
  onToggle,
  onRemovedWithFocus,
  olderFocused
}: {
  count: number
  open: boolean
  onToggle: () => void
  /** It is going away while it holds focus, so the list can hand focus on. Stable. */
  onRemovedWithFocus: () => void
  /** Focus is in one of this list's older rows or a menu one of them opened. */
  olderFocused: () => boolean
}): React.JSX.Element {
  const t = useTranslate()
  const toggleRef = useRef<HTMLButtonElement>(null)
  // Runs before its button leaves the page, while focus is still on it.
  useLayoutEffect(() => {
    const button = toggleRef.current
    return () => {
      if (button !== null && document.activeElement === button) {
        onRemovedWithFocus()
      }
    }
  }, [onRemovedWithFocus])
  const toggle = (): void => {
    if (open && olderFocused()) {
      // Focus would otherwise drop to the page as the focused row goes away.
      toggleRef.current?.focus()
    }
    onToggle()
  }
  return (
    <div className="flex min-w-0 items-center pr-2 pl-1 text-2xs text-muted-foreground">
      <button
        ref={toggleRef}
        type="button"
        data-bot-sidebar-older-toggle=""
        aria-expanded={open}
        className="cursor-pointer rounded-sm whitespace-nowrap outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={toggle}
      >
        {open
          ? t('bots.chats.hideOlder', 'Hide older')
          : t('bots.chats.older', 'Show {{count}} older', { count })}
      </button>
    </div>
  )
}
