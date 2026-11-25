// Waiting asks what it waits on; every other move, Cancel too, happens at once.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import {
  BOT_ITEM_LIMITS,
  type BotItem,
  type BotItemStatus
} from '../../../../../shared/bots/bot-items'

/** A Waiting move asking what it waits on, the items it moves, and the line to start from (a wait being
 *  edited). */
type BotItemNoting = { items: readonly BotItem[]; text?: string }

/** A move to any status: Waiting asks what it waits on first, in the returned dialog. */
export function useBotItemStatusNotes(
  move: (items: readonly BotItem[], to: BotItemStatus, note?: string) => void
): { move: (items: readonly BotItem[], to: BotItemStatus) => void; dialog: React.JSX.Element } {
  const [noting, setNoting] = useState<BotItemNoting | null>(null)
  return {
    move: (items, to) => {
      if (to !== 'waiting') {
        move(items, to)
        return
      }
      // Waiting again on one Waiting item edits what it waits on.
      const [only] = items
      const text = items.length === 1 ? only?.wait?.text : undefined
      setNoting({ items, ...(text ? { text } : {}) })
    },
    dialog: (
      <BotItemStatusNoteDialog
        noting={noting}
        onDone={({ items }, note) => {
          setNoting(null)
          move(items, 'waiting', note)
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
  const count = shown?.items.length ?? 0
  const title = shown?.items[0]?.title ?? ''
  const submit = (): void => {
    if (noting && note.trim()) {
      onDone(noting, note.trim())
      setNote('')
    }
  }
  return (
    <Dialog open={noting !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {count === 1
              ? t('bots.items.wait.titleOne', 'What is {{title}} waiting on?', { title })
              : t('bots.items.wait.titleMany', 'What are {{count}} items waiting on?', { count })}
          </DialogTitle>
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
            maxLength={BOT_ITEM_LIMITS.wait}
            placeholder={t('bots.items.wait.placeholder', 'Waiting on')}
            onChange={(event) => setNote(event.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('bots.items.wait.keep', 'Cancel')}
          </Button>
          <Button size="sm" disabled={!note.trim()} onClick={submit}>
            {t('bots.items.wait.confirm', 'Set Waiting')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
