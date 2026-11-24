import { useBotWebhooks } from '@/lib/bot-catalog'
import type { Translate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { automationWontFire } from '../automations/details/automation-wont-fire'
import type { BotAutomationCardRow } from './bot-automation-card'
import { paused, wontFireState } from './bot-automation-row-controls'
import type { BotRowState } from './BotPanelRow'
import { useOrcaCloudSignedOut } from './orca-cloud-signed-out'

export type NormalAutomationCardRow = Extract<BotAutomationCardRow, { kind: 'automation' }>
export type AutomationEnabledOverride = { enabled: boolean; from: number }

export function useBotAutomationMembership(bot: Bot, hasConnectorNeed: boolean) {
  return {
    bot,
    hasConnectorNeed,
    webhooks: useBotWebhooks(bot.hostId),
    cloudSignedOut: useOrcaCloudSignedOut()
  }
}

export type BotAutomationMembership = ReturnType<typeof useBotAutomationMembership>

export function botAutomationMembershipState(
  card: NormalAutomationCardRow,
  facts: BotAutomationMembership,
  t: Translate,
  enabled: boolean
): BotRowState | null {
  if (!enabled && !card.running) {
    return paused(t)
  }
  if (card.failed) {
    return { kind: 'failed', label: t('bots.automations.failed', 'Failed') }
  }
  if (card.running) {
    return { kind: 'running', label: t('bots.automations.running', 'Running') }
  }
  const { automation, needsSignIn } = card.row
  const wontFire = automationWontFire(automation, [facts.bot], facts.webhooks, facts.cloudSignedOut)
  if (wontFire) {
    return wontFireState(wontFire.label)
  }
  return needsSignIn && !facts.hasConnectorNeed
    ? {
        kind: 'alert',
        label: t('bots.upcoming.needsSignIn', 'Needs sign-in'),
        reason: t('bots.upcoming.lastNeededSignIn', 'Its last run stopped for a sign-in')
      }
    : null
}
