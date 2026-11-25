import { translate } from '@/i18n/i18n'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../../shared/bot-types'
import type { Repo } from '../../../../../shared/repository/repo-types'

export function botTargetLabel(name: string): string {
  return translate('automations.botTarget.option', 'Bot · {{name}}', { name })
}

/** What an automation runs in: its bot, or its project. */
export function automationTargetLabel(
  automation: Pick<Automation, 'bot'>,
  repo: Pick<Repo, 'displayName'> | null | undefined,
  bots: readonly Pick<Bot, 'id' | 'name'>[]
): string {
  if (automation.bot) {
    const botId = automation.bot.botId
    const bot = bots.find((entry) => entry.id === botId)
    return bot
      ? botTargetLabel(bot.name)
      : translate('automations.botTarget.deletedBot', 'Deleted bot')
  }
  return (
    repo?.displayName ??
    translate('auto.components.automations.AutomationsPage.13118faadf', 'Unknown project')
  )
}
