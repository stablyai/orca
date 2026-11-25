// "Show N older" under a bot's chats in the sidebar: the settled chats a day untouched, folded. The
// toggle stays where it is when opened, with the older rows below it, so "Hide older" never moves
// under the pointer; hiding them with focus on one of them moves focus to the toggle.
import type React from 'react'
import { useId, useRef } from 'react'
import { useTranslate } from '@/i18n/use-translate'

export function BotSidebarOlderChats({
  count,
  open,
  onToggle,
  children
}: {
  count: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const listId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const toggle = (): void => {
    if (open && listRef.current?.contains(document.activeElement)) {
      // Focus would otherwise drop to the page as the focused row goes away.
      toggleRef.current?.focus()
    }
    onToggle()
  }
  return (
    <>
      <div className="flex min-w-0 items-center pr-2 pl-1 text-2xs text-muted-foreground">
        <button
          ref={toggleRef}
          type="button"
          data-bot-sidebar-older-toggle=""
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className="cursor-pointer rounded-sm whitespace-nowrap outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={toggle}
        >
          {open
            ? t('bots.chats.hideOlder', 'Hide older')
            : t('bots.chats.older', 'Show {{count}} older', { count })}
        </button>
      </div>
      {open ? (
        <div ref={listRef} id={listId} className="flex flex-col gap-1">
          {children}
        </div>
      ) : null}
    </>
  )
}
