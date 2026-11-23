// The moves that need a line: Cancel asks why (the reason stays on the item and goes to the bot;
// nothing is deleted), Waiting asks what it waits on.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  BOT_ITEM_LIMITS,
  type BotItem,
  type BotItemStatus
} from '../../../../../shared/bots/bot-items'

export type BotItemNotedStatus = 'canceled' | 'waiting'

/** A move asking for its line, the items it moves, and the line to start from (a wait being edited). */
export type BotItemNoting = { to: BotItemNotedStatus; items: readonly BotItem[]; text?: string }

/** A move to any status: Canceled and Waiting ask for their line first, in the returned dialog. */
export function useBotItemStatusNotes(
  move: (items: readonly BotItem[], to: BotItemStatus, note?: string) => void
): { move: (items: readonly BotItem[], to: BotItemStatus) => void; dialog: React.JSX.Element } {
  const [noting, setNoting] = useState<BotItemNoting | null>(null)
  return {
    move: (items, to) => {
      if (to !== 'canceled' && to !== 'waiting') {
        move(items, to)
        return
      }
      // Waiting again on one Waiting item edits what it waits on.
      const [only] = items
      const text = to === 'waiting' && items.length === 1 ? only?.wait?.text : undefined
      setNoting({ to, items, ...(text ? { text } : {}) })
    },
    dialog: (
      <BotItemStatusNoteDialog
        noting={noting}
        onDone={({ to, items }, note) => {
          setNoting(null)
          move(items, to, note)
        }}
        onClose={() => setNoting(null)}
      />
    )
  }
}

function BotItemStatusNoteDialog({
  noting,
  onDone,
  onClose
}: {
  /** Null while closed. */
  noting: BotItemNoting | null
  onDone: (noting: BotItemNoting, note: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [note, setNote] = useState('')
  // Each opening starts from its own line, never what an earlier one left; closing keeps its words.
  const [shown, setShown] = useState<BotItemNoting | null>(null)
  if (noting !== null && noting !== shown) {
    setShown(noting)
    setNote(noting.text ?? '')
  }
  const to = shown?.to ?? 'canceled'
  const count = shown?.items.length ?? 0
  const words = copy(to, t, count, shown?.items[0]?.title ?? '')
  const submit = (): void => {
    if (noting && note.trim()) {
      onDone(noting, note.trim())
      setNote('')
    }
  }
  return (
    <Dialog open={noting !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-sm"
        {...(words.why ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle>{words.title}</DialogTitle>
          {words.why ? <DialogDescription>{words.why}</DialogDescription> : null}
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Input
            autoFocus
            value={note}
            maxLength={to === 'waiting' ? BOT_ITEM_LIMITS.wait : undefined}
            placeholder={words.placeholder}
            onChange={(event) => setNote(event.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {words.keep}
          </Button>
          <Button size="sm" disabled={!note.trim()} onClick={submit}>
            {words.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function copy(
  to: BotItemNotedStatus,
  t: Translate,
  count: number,
  title: string
): { title: string; why: string | null; placeholder: string; keep: string; confirm: string } {
  if (to === 'waiting') {
    return {
      title:
        count === 1
          ? t('bots.items.wait.titleOne', 'What is {{title}} waiting on?', { title })
          : t('bots.items.wait.titleMany', 'What are {{count}} items waiting on?', { count }),
      why: null,
      placeholder: t('bots.items.wait.placeholder', 'Waiting on'),
      keep: t('bots.items.wait.keep', 'Cancel'),
      confirm: t('bots.items.wait.confirm', 'Set Waiting')
    }
  }
  return {
    title:
      count === 1
        ? t('bots.items.cancel.titleOne', 'Cancel {{title}}?', { title })
        : t('bots.items.cancel.titleMany', 'Cancel {{count}} items?', { count }),
    why: t('bots.items.cancel.why', 'The bot sees the reason. Nothing is deleted.'),
    placeholder: t('bots.items.cancel.placeholder', 'Reason'),
    keep: t('bots.items.cancel.keep', 'Keep'),
    confirm:
      count === 1
        ? t('bots.items.cancel.confirmOne', 'Cancel item')
        : t('bots.items.cancel.confirmMany', 'Cancel {{count}}', { count })
  }
}
