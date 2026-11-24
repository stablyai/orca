// Stop sharing a link whose bot isn't on this computer, confirmed: the link stops working.
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { settleBotShare, stopBotShare } from './bot-share-rpc'

/** Stop sharing, confirmed: the link stops working. Needs only the link, so a link whose bot isn't on
 *  this computer can be stopped too. */
export function BotShareStopDialog({
  name,
  shareId,
  onStopped,
  onCancel
}: {
  name: string
  shareId: string
  onStopped: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stop = async (): Promise<void> => {
    setStopping(true)
    setError(null)
    const result = await settleBotShare(stopBotShare(shareId))
    setStopping(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success(t('bots.share.stopped', 'Stopped sharing {{name}}', { name }))
    onStopped()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('bots.share.stopTitle', 'Stop sharing {{name}}?', { name })}</DialogTitle>
          <DialogDescription>
            {t('bots.share.stopDescription', 'The link stops working.')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="items-center">
          {error ? (
            <span className="mr-auto text-xs text-destructive" role="alert">
              {error}
            </span>
          ) : null}
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('bots.share.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? <Loader2 className="animate-spin" /> : null}
            {t('bots.share.stopSharing', 'Stop sharing')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
