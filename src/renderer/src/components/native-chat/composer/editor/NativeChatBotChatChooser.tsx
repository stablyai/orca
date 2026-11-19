// A bot pill's ⌄: the bot's chats in a list at the pill, the current one checked. Picking one changes
// the pill (Home Chat makes it the bot alone); Esc or a click elsewhere changes nothing.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type {
  NativeChatBotChatPicker,
  NativeChatMentionChat
} from '../../native-chat-mention-chats'
import {
  NativeChatMentionChatList,
  nativeChatMentionChatOptions
} from '../pickers/NativeChatMentionChatList'

export function NativeChatBotChatChooser({
  picker,
  botId,
  chatId,
  open,
  onOpenChange,
  onPick,
  label,
  children
}: {
  picker: NativeChatBotChatPicker
  botId: string
  /** The pill's chat; empty for the bot alone. */
  chatId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (chat: NativeChatMentionChat) => void
  /** "Change chat" on a chat pill, "Choose chat" on the bot alone. */
  label: string
  /** The pill, given its ⌄ to hold at its end. */
  children: (toggle: ReactNode) => ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const listboxId = `native-chat-chat-chooser-${useId().replaceAll(':', '')}`
  // Null until an arrow moves it: the current chat, once the list has it.
  const [moved, setMoved] = useState<number | null>(null)
  const activeItemRef = useRef<HTMLButtonElement | null>(null)
  const { view } = picker
  useEffect(() => {
    if (!open) {
      return
    }
    view(botId)
    return () => view(null)
  }, [open, view, botId])
  const shown = open && picker.shown?.botId === botId ? picker.shown : null
  const options = shown ? nativeChatMentionChatOptions(shown, '') : []
  // A plain pill names the Home Chat, the row that gives it.
  const checkedId = chatId || options.find((chat) => chat.plain)?.id || null
  const checkedIndex = options.findIndex((chat) => chat.id === checkedId)
  const activeIndex = moved ?? Math.max(0, checkedIndex)
  const openChange = (next: boolean): void => {
    setMoved(null)
    onOpenChange(next)
  }
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverAnchor asChild>
        <span className="inline-flex max-w-full">
          {children(
            <button
              type="button"
              aria-label={label}
              title={label}
              aria-expanded={open}
              aria-haspopup="listbox"
              // The editor keeps its caret; the click alone opens or closes the list.
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                openChange(!open)
              }}
              className="-mr-1 inline-flex size-3.5 shrink-0 items-center justify-center rounded-full hover:bg-accent hover:text-accent-foreground"
            >
              <ChevronDown aria-hidden className="size-3" />
            </button>
          )}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="top"
        className="w-72"
        // The list takes focus itself, so its keys work from the first press.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={
            options.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined
          }
          className="scrollbar-sleek max-h-72 overflow-x-hidden overflow-y-auto p-1 outline-none"
          ref={(node) => {
            if (open) {
              node?.focus()
            }
          }}
          onKeyDown={(event) => {
            // Its Retry button keeps its own keys, and Shift+Tab or a chord moves focus as usual.
            const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
            if (event.target !== event.currentTarget || !plain) {
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (options.length > 0) {
                const step = event.key === 'ArrowDown' ? 1 : -1
                setMoved((activeIndex + step + options.length) % options.length)
              }
            } else if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              const chosen = options[activeIndex]
              if (chosen) {
                setMoved(null)
                onPick(chosen)
              }
            }
          }}
        >
          {shown ? (
            <NativeChatMentionChatList
              shown={shown}
              filter=""
              activeIndex={activeIndex}
              listboxId={listboxId}
              checkedId={checkedId}
              activeItemRef={activeItemRef}
              onPick={onPick}
              onRetry={picker.retry}
            />
          ) : (
            <span className="sr-only">
              {t('components.native-chat.composer.chooseChat', 'Choose chat')}
            </span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
