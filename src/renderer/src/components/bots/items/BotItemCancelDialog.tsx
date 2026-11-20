// Cancel asks why: the reason stays on the item and goes to the bot. Nothing is deleted.
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
import { useTranslate } from '@/i18n/use-translate'
import type { BotItem } from '../../../../../shared/bots/bot-items'

export function BotItemCancelDialog({
  items,
  onCancel,
  onClose
}: {
  /** The items to cancel; null while closed. */
  items: readonly BotItem[] | null
  onCancel: (reason: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [reason, setReason] = useState('')
  const count = items?.length ?? 0
  const submit = (): void => {
    if (reason.trim()) {
      onCancel(reason.trim())
      setReason('')
    }
  }
  return (
    <Dialog open={items !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {count === 1
              ? t('bots.items.cancel.titleOne', 'Cancel {{title}}?', {
                  title: items?.[0]?.title ?? ''
                })
              : t('bots.items.cancel.titleMany', 'Cancel {{count}} items?', { count })}
          </DialogTitle>
          <DialogDescription>
            {t('bots.items.cancel.why', 'The bot sees the reason. Nothing is deleted.')}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Input
            autoFocus
            value={reason}
            placeholder={t('bots.items.cancel.placeholder', 'Reason')}
            onChange={(event) => setReason(event.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('bots.items.cancel.keep', 'Keep')}
          </Button>
          <Button size="sm" disabled={!reason.trim()} onClick={submit}>
            {count === 1
              ? t('bots.items.cancel.confirmOne', 'Cancel item')
              : t('bots.items.cancel.confirmMany', 'Cancel {{count}}', { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
