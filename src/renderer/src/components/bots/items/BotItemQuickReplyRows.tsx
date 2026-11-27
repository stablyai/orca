// An open question's answers: one row per quick reply, the recommended one first with its label and a
// light tint, then an Other… field. Keys 1–n pick a row and n+1 goes to the field while
// the item's pane has focus outside any text field; Enter in an empty field picks the recommended reply.
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import type { BotItemQuickReply } from '../../../../../shared/bots/bot-item-ask'
import { BOT_ITEM_CHOICES_ATTRIBUTE } from './bot-item-comment-typing'

// Bleeds 4px past the column so the key column stays on the body's edge and the tint clears the card's hairline.
const ROW =
  '-mx-1 flex min-h-9 w-[calc(100%+var(--spacing)*2)] items-center gap-2.5 rounded-md px-1 text-left text-[13px] leading-[19px]'

function Key({ label }: { label: string }): React.JSX.Element {
  return (
    <ShortcutKeyCombo
      keys={[label]}
      size="compact"
      className="shrink-0"
      keyCapClassName="min-w-4.5"
    />
  )
}

/** Recommended first; the others keep the agent's order. */
function orderedReplies(replies: readonly BotItemQuickReply[]): BotItemQuickReply[] {
  return [...replies.filter((reply) => reply.recommended), ...replies.filter((r) => !r.recommended)]
}

export function BotItemQuickReplyRows({
  question,
  quickReplies,
  onPick,
  onOther,
  onAnswerInBox,
  current,
  other: draft,
  onOtherChange,
  rowsRef
}: {
  question: string
  quickReplies: readonly BotItemQuickReply[]
  /** `edit`: Alt- or Shift-click, the reply's words into the comment box to add to first. */
  onPick: (reply: BotItemQuickReply, edit: boolean) => void
  onOther: (words: string) => void
  /** Answer in the comment box instead, which can attach files: it names this question again. The
   *  only way for a question with no replies; Shift- or Alt-Enter in Other… otherwise. */
  onAnswerInBox: (words: string) => void
  /** The reply picked before, on a line reopened to change it. */
  current?: string
  /** The Other… field's words, when the caller keeps them across its own changes. */
  other?: string
  onOtherChange?: (words: string) => void
  rowsRef?: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  const [ownOther, setOwnOther] = useState('')
  const other = draft ?? ownOther
  const setOther = onOtherChange ?? setOwnOther
  const ownRows = useRef<HTMLDivElement | null>(null)
  const rows = rowsRef ?? ownRows
  const field = useRef<HTMLInputElement | null>(null)
  const replies = orderedReplies(quickReplies)
  const recommended = replies.find((reply) => reply.recommended) ?? null
  const otherKey = replies.length + 1
  const pick = (reply: BotItemQuickReply): void => onPick(reply, false)
  const sendOther = (): void => {
    const words = other.trim()
    if (words) {
      setOther('')
      onOther(words)
    } else if (recommended) {
      pick(recommended)
    }
  }

  const onPaneKey = useEffectEvent((event: KeyboardEvent): void => {
    const node = rows.current
    if (
      !node ||
      event.defaultPrevented ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      isImeOwnedKeyboardEvent(event) ||
      isEditableTarget(event.target) ||
      !/^[1-9]$/.test(event.key) ||
      // Offline, the pane's fieldset disables every control here.
      node.closest('fieldset')?.disabled
    ) {
      return
    }
    const index = Number(event.key) - 1
    if (index < replies.length) {
      event.preventDefault()
      pick(replies[index]!)
    } else if (index === replies.length) {
      // Prevented, or the digit lands in the field it just focused.
      event.preventDefault()
      if (replies.length === 0) {
        onAnswerInBox('')
      } else {
        field.current?.focus()
      }
    }
  })
  useEffect(() => {
    const node = rows.current
    // Outside an item's pane (a demo), only keys from inside the rows count.
    const scope = node?.closest<HTMLElement>('[data-bot-item-pane]') ?? node
    if (!scope) {
      return
    }
    const listener = (event: KeyboardEvent): void => onPaneKey(event)
    scope.addEventListener('keydown', listener)
    return () => scope.removeEventListener('keydown', listener)
  }, [rows])

  return (
    <div
      ref={rows}
      {...{ [BOT_ITEM_CHOICES_ATTRIBUTE]: otherKey }}
      role="group"
      aria-label={question}
      className="mt-1.5 flex flex-col"
    >
      {replies.map((reply, index) => (
        <button
          key={reply.label}
          type="button"
          aria-pressed={current === undefined ? undefined : reply.label === current}
          title={reply.detail ? `${reply.label}\n${reply.detail}` : reply.label}
          className={cn(
            ROW,
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            reply.recommended
              ? 'bg-theme-accent/8 hover:bg-theme-accent/14'
              : 'hover:bg-foreground/5'
          )}
          onClick={(event) => onPick(reply, event.altKey || event.shiftKey)}
        >
          <Key label={String(index + 1)} />
          {/* In a narrow pane, Recommended moves under the label so the label keeps the row. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-2.5 @max-[18rem]/item-pane:flex-col @max-[18rem]/item-pane:gap-0 @max-[18rem]/item-pane:py-1">
            <span className="w-full min-w-0 flex-1 truncate text-foreground">{reply.label}</span>
            {reply.recommended ? (
              <span className="shrink-0 text-xs text-theme-accent">
                {t('bots.items.ask.recommended', 'Recommended')}
              </span>
            ) : null}
          </span>
          {reply.label === current ? (
            <Check aria-hidden className="size-3.5 shrink-0 text-theme-accent" />
          ) : null}
        </button>
      ))}
      {replies.length === 0 ? (
        // No replies: the comment box is the answer field, as it takes files too.
        <button
          type="button"
          className={cn(
            ROW,
            'text-muted-foreground outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50'
          )}
          onClick={() => onAnswerInBox('')}
        >
          <Key label={String(otherKey)} />
          <span className="min-w-0 flex-1 truncate">
            {t('bots.items.ask.yourAnswer', 'Your answer…')}
          </span>
        </button>
      ) : (
        // Clicking anywhere on the row types into it, as on a field.
        <div
          className={cn(ROW, 'cursor-text focus-within:bg-foreground/5 hover:bg-foreground/5')}
          onPointerDown={(event) => {
            if (event.target !== field.current) {
              event.preventDefault()
              field.current?.focus()
            }
          }}
        >
          <Key label={String(otherKey)} />
          <input
            ref={field}
            value={other}
            aria-label={t('bots.items.ask.otherLabel', 'Other answer')}
            title={t(
              'bots.items.ask.otherToBox',
              'Shift+Enter answers in the comment box, to attach files'
            )}
            placeholder={t('bots.items.ask.other', 'Other…')}
            className="h-9 min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(event) => setOther(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || isImeOwnedKeyboardEvent(event)) {
                return
              }
              event.preventDefault()
              if (event.shiftKey || event.altKey) {
                // The words go after the box's own draft, which stays.
                const words = other.trim()
                setOther('')
                onAnswerInBox(words)
              } else {
                sendOther()
              }
            }}
          />
          {other.trim() ? (
            <button
              type="button"
              aria-label={t('bots.items.ask.sendOther', 'Send answer')}
              className="shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={sendOther}
            >
              <Key label="↵" />
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
