// Reply, on an open question this page can't answer in its own card (an older host, or a question asked
// before its host recorded answers): a box opens under the question and sends a plain comment, as the
// comment box does. While the bot asks, its host takes that comment as the answer and hands the item
// back, which wakes the bot. Its words are kept per question until sent, so Back or a step loses none.
import { useState } from 'react'
import { Reply } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { BOT_ITEM_LIMITS } from '../../../../../shared/bots/bot-items'

const drafts = new Map<string, string>()

export function BotItemQuestionReply({
  draftKey,
  asker,
  onSend
}: {
  /** Names the question, so each one keeps its own words. */
  draftKey: string
  /** Who asked, as the question card names them. */
  asker: string
  onSend: (text: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '')
  const [open, setOpen] = useState(false)
  const label = t('bots.items.ask.reply', 'Reply')
  const change = (next: string): void => {
    setText(next)
    if (next) {
      drafts.set(draftKey, next)
    } else {
      drafts.delete(draftKey)
    }
  }
  const send = (): void => {
    const words = text.trim()
    if (!words) {
      return
    }
    change('')
    setOpen(false)
    onSend(words)
  }
  if (!open) {
    return (
      <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
        <Reply />
        {label}
      </Button>
    )
  }
  return (
    <div className="rounded-[10px] border border-border bg-background p-1.5 focus-within:border-foreground/20">
      <textarea
        // Shown only by its own Reply click, so focus follows that click.
        autoFocus
        aria-label={label}
        value={text}
        maxLength={BOT_ITEM_LIMITS.text}
        rows={2}
        placeholder={t('bots.items.ask.replyPlaceholder', 'Reply to {{name}}…', { name: asker })}
        className="scrollbar-sleek block max-h-[152px] min-h-[38px] w-full resize-none bg-transparent px-1 text-[13px] leading-[19px] text-foreground outline-none [field-sizing:content]"
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (isImeOwnedKeyboardEvent(event)) {
            return
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          } else if (event.key === 'Escape') {
            // Folds the box, words kept; the item pane's Escape (Back) waits for the next press.
            event.stopPropagation()
            setOpen(false)
          }
        }}
      />
      <div className="mt-1 flex items-center justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>
          {t('bots.items.ask.cancelReply', 'Cancel')}
        </Button>
        <Button size="xs" disabled={!text.trim()} onClick={send}>
          {t('bots.items.ask.sendReply', 'Send')}
        </Button>
      </div>
    </div>
  )
}
