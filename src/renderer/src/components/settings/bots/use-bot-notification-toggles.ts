import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '@/components/bots/use-bot-host-label'
import type { Bot, BotNotifications } from '../../../../../shared/bot-types'

export type BotNotificationToggle = {
  key: keyof BotNotifications
  label: string
  description: string
}

/** The bot's three notification switches with their descriptions, in order. */
export function useBotNotificationToggles(bot: Bot): BotNotificationToggle[] {
  const t = useTranslate()
  const host = useBotHostLabel(bot.hostId)
  return [
    {
      key: 'needsPermission',
      label: t('settings.bots.notifyNeedsPermission', 'Needs permission'),
      description: t(
        'settings.bots.notifyNeedsPermissionDescription',
        'When the bot or a worker needs your approval.',
        { name: bot.name }
      )
    },
    {
      key: 'taskComplete',
      label: t('settings.bots.notifyTaskComplete', 'Task complete'),
      description: t(
        'settings.bots.notifyTaskCompleteDescription',
        'When a thread, automation or worker finishes.'
      )
    },
    {
      key: 'couldNotFinish',
      label: t('settings.bots.notifyCouldNotFinish', 'Couldn’t finish'),
      // A server sends these as push only, so this computer never shows them.
      description: host
        ? t(
            'settings.bots.notifyCouldNotFinishOnHostDescription',
            'An automation run or worker fails. Only phones paired to {{host}} hear of it.',
            { host }
          )
        : t('settings.bots.notifyCouldNotFinishDescription', 'An automation run or worker fails.')
    }
  ]
}
