import { useBotWebhooks } from '@/lib/bot-catalog'
import type { Translate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { automationWontFire } from '../automations/details/automation-wont-fire'
import type { BotAutomationCardRow } from './bot-automation-card'
import { paused, wontFireState } from './bot-automation-row-controls'
import type { BotRowState } from './BotPanelRow'
import { useOrcaCloudSignedOut } from './orca-cloud-signed-out'

export type NormalAutomationCardRow = Extract<BotAutomationCardRow, { kind: 'automation' }>
/** The bot visit, Activity authority and row a Pause/Resume save was asked from. */
export type AutomationOverrideOwner = { generation: symbol; authorityKey: string; rowKey: string }
/** A row's own Pause/Resume result until the list re-reads; `from` is the record it changed. */
export type AutomationEnabledOverride = {
  enabled: boolean
  from: number
  owner: AutomationOverrideOwner
}

/**
 * A save counts only for the owner that asked for it, so a re-pair (or a late reply from before one)
 * cannot speak for the replacement's row even with the same id and timestamp.
 */
export function ownedOverride(
  saved: AutomationEnabledOverride | null,
  owner: AutomationOverrideOwner | null
): AutomationEnabledOverride | null {
  return saved &&
    owner &&
    saved.owner.generation === owner.generation &&
    saved.owner.authorityKey === owner.authorityKey &&
    saved.owner.rowKey === owner.rowKey
    ? saved
    : null
}

/** The enabled state a row shows and Delete admits with: an owned save of the record shown. */
export function automationEnabled(
  automation: { enabled: boolean; updatedAt: number },
  saved: AutomationEnabledOverride | null,
  owner: AutomationOverrideOwner | null
): boolean {
  const owned = ownedOverride(saved, owner)
  return owned?.from === automation.updatedAt ? owned.enabled : automation.enabled
}

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
