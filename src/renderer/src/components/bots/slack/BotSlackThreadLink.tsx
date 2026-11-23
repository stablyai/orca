// "Show “Open this thread in Orca” link": whether the bot's replies in this workspace end with the
// link back to the thread in Orca. On until someone turns it off, so a reply shared with a channel
// shows everyone a link only this Orca can open unless it is off.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { botSlackCalls } from '@/lib/bot-connector-host-calls'
import { refreshBotSlack } from '@/lib/bot-slack-state'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import { useBotHostLabel } from '../use-bot-host-label'
import { botSlackErrorMessage } from './bot-slack-copy'

type Installed = Extract<ConnectorBotSlackState, { state: 'installed' }>

export function BotSlackThreadLink({
  bot,
  slack,
  className
}: {
  bot: Bot
  slack: Installed
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const hostLabel = useBotHostLabel(bot.hostId)
  // The switch's pick while the cloud takes it; null once replies carry what it shows.
  const [asked, setAsked] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  if (slack.threadLink === undefined) {
    return null
  }
  const shown = asked ?? slack.threadLink
  const title = t('bots.slack.threadLink.title', 'Show “Open this thread in Orca” link')

  const apply = async (on: boolean): Promise<void> => {
    setAsked(on)
    setBusy(true)
    const result = await botSlackCalls(bot.hostId).setThreadLink({
      botId: bot.id,
      teamId: slack.teamId,
      threadLink: on
    })
    setBusy(false)
    if (!result.ok) {
      setAsked(null)
      toast.error(botSlackErrorMessage(result.error, hostLabel))
      return
    }
    await refreshBotSlack(bot)
    setAsked(null)
  }

  return (
    <div className={cn('flex items-start justify-between gap-3 text-xs leading-5', className)}>
      <div className="min-w-0">
        <p className="text-foreground">{title}</p>
        <p className="text-muted-foreground">
          {t('bots.slack.threadLink.detail', 'Off leaves it out of the bot’s new replies here.')}
        </p>
      </div>
      <Switch
        size="compact"
        className="mt-1"
        checked={shown}
        disabled={busy}
        pending={busy ? 'saving' : undefined}
        aria-label={title}
        onCheckedChange={(on) => void apply(on)}
      />
    </div>
  )
}
