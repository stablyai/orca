// @protected-copy: drawn inside the security-surface setup dialog
import { Loader2 } from 'lucide-react'
import { isMac } from '@/app-shell/chrome/app-window-chrome'
import { useTranslate } from '@/i18n/use-translate'

export function SlackSetupProgress({
  checking,
  handOff,
  email,
  hostName
}: {
  checking: boolean
  handOff: boolean
  email: string | null
  hostName: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const status = (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {checking
        ? t('bots.slack.setup.checking', 'Checking Slack…')
        : t('bots.slack.setup.settingUp', 'Setting up your Slack app…')}
    </p>
  )
  return handOff && email && hostName ? (
    <div className="space-y-4">
      <p className="text-sm">
        {isMac
          ? t(
              'bots.slack.handOff.confirmMac',
              'Orca on this Mac creates the Slack app with {{email}}’s token. {{host}} gets only this bot’s app.',
              { email, host: hostName }
            )
          : t(
              'bots.slack.handOff.confirm',
              'Orca on this computer creates the Slack app with {{email}}’s token. {{host}} gets only this bot’s app.',
              { email, host: hostName }
            )}
      </p>
      {status}
    </div>
  ) : (
    status
  )
}
