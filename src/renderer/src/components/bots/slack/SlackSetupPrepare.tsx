// @protected-copy: drawn inside the security-surface setup dialog
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'

export function SlackSetupPrepare({
  update,
  onContinue,
  onClose
}: {
  update: boolean
  onContinue: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-4">
      <p className="text-sm">
        {t(
          'bots.slack.setup.prepare',
          'Continue to create or update this bot’s Slack app, then approve it in Slack.'
        )}
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('bots.slack.setup.close', 'Close')}
        </Button>
        <Button autoFocus onClick={onContinue}>
          {update
            ? t('bots.slack.connection.update', 'Update in Slack')
            : t('bots.slack.setup.continue', 'Continue setup')}
        </Button>
      </DialogFooter>
    </div>
  )
}
