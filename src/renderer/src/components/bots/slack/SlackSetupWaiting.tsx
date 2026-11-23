import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { SlackCopyLink } from './slack-hand-off-parts'
import type { SlackInstallLink } from './slack-install-link'

export function SlackSetupWaiting({
  botName,
  hostName,
  link,
  copied,
  teamId,
  onCopy,
  onClose,
  onInstallAgain
}: {
  botName: string
  hostName: string | null
  link: SlackInstallLink | null
  copied: boolean
  teamId: string
  onCopy: () => Promise<void>
  onClose: () => void
  onInstallAgain: (teamId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-4">
      <p role="status" className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t('bots.slack.setup.waiting', 'Waiting for Slack…')}
      </p>
      {hostName && link ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t(
              'bots.slack.setup.approveAsYourself',
              'Approve in Slack as yourself. Approving in another browser?'
            )}{' '}
            <SlackCopyLink link={link} copied={copied} onCopy={onCopy} />
          </p>
          <p className="text-sm text-muted-foreground">
            {t(
              'bots.slack.setup.waitingAdmin',
              'If your workspace needs an admin to approve new apps, {{name}} joins once they do. If they decline, Install again reuses the same app.',
              { name: botName }
            )}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(
            'bots.slack.setup.waitingDetail',
            'Finish in Slack. If your workspace needs an admin to approve new apps, {{name}} joins once they do. If they decline, Install again reuses the same app.',
            { name: botName }
          )}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('bots.slack.setup.close', 'Close')}
        </Button>
        <Button variant="outline" onClick={() => onInstallAgain(teamId)}>
          {t('bots.slack.setup.installAgain', 'Install again')}
        </Button>
      </DialogFooter>
    </div>
  )
}
