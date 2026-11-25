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

export function BotAutomationRunAgainDialog({
  open,
  onClose,
  onConfirm
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent surface="security">
        <DialogHeader>
          <DialogTitle>{t('bots.automationPanel.runAgainTitle', 'Run again?')}</DialogTitle>
          <DialogDescription>
            {t(
              'bots.automationPanel.runAgainBody',
              'The earlier request may already have started a run. Running again may create another one.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={onConfirm}>
            {t('bots.automationPanel.confirmRunAgain', 'Run again')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
