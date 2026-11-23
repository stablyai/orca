import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { SlackHandOffConfirm } from './slack-hand-off-parts'

export function SlackSetupWorking({
  settingUp,
  handOff,
  email,
  hostName
}: {
  settingUp: boolean
  handOff: boolean
  email: string | null
  hostName: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const status = (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {settingUp
        ? t('bots.slack.setup.settingUp', 'Setting up your Slack app…')
        : t('bots.slack.setup.checking', 'Checking Slack…')}
    </p>
  )
  return settingUp && handOff && email && hostName ? (
    <div className="space-y-4">
      <SlackHandOffConfirm email={email} host={hostName} />
      {status}
    </div>
  ) : (
    status
  )
}
