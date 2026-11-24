import { useContext, useId, useRef, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import { useBotHostOnOwnAccount } from '@/lib/bot-host-orca-account'
import type { Bot } from '../../../../../shared/bot-types'
import { SettingsControlsOffContext } from '../settings-view/BotSettingsRows'

export function BotSlackThreadReplies({
  bot,
  supported
}: {
  bot: Bot
  supported: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const owner = useBotHostOnOwnAccount(bot.hostId)
  const offline = useContext(SettingsControlsOffContext)
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const mentions = bot.slackThreadReplies === 'mentions'

  const change = async (on: boolean): Promise<void> => {
    if (saving.current || !supported || !owner || offline) {
      return
    }
    saving.current = true
    setBusy(true)
    setFailed(false)
    try {
      await updateBot(bot, { slackThreadReplies: on ? 'mentions' : 'always' })
    } catch {
      setFailed(true)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <div className="text-[13px]">
      <div className="flex min-h-11 items-center gap-3">
        <label htmlFor={id} className="min-w-0 flex-1 font-medium leading-5">
          {t('bots.slack.threadReplies.label', 'Only reply when mentioned in threads')}
        </label>
        <Switch
          id={id}
          checked={mentions}
          disabled={!supported || !owner || offline || busy}
          aria-describedby={`${id}-detail`}
          onCheckedChange={(on) => void change(on)}
        />
      </div>
      <p id={`${id}-detail`} className="text-xs leading-5 text-muted-foreground">
        {t(
          'bots.slack.threadReplies.detail',
          'Applies to this bot in every Slack workspace. DMs always get a reply. When off, replies in joined threads do not need a mention.'
        )}
      </p>
      {!supported ? (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {mentions
            ? t(
                'bots.slack.threadReplies.waiting',
                'Your saved choice is not active: this Slack connection does not support it yet.'
              )
            : t(
                'bots.slack.threadReplies.unsupported',
                'This Slack connection does not support this option yet.'
              )}
        </p>
      ) : !owner ? (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t('bots.slack.threadReplies.ownerOnly', 'Only the bot’s owner can change this option.')}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="mt-1 text-xs leading-5 text-destructive">
          {t('bots.slack.threadReplies.failed', 'Could not save. Try the switch again.')}
        </p>
      ) : null}
    </div>
  )
}
