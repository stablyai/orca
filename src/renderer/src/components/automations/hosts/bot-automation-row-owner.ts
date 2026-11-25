import { useAppStore } from '@/store'
import type { BotRef } from '@/lib/bot-hosts'
import type {
  BotActivity,
  BotSessionActivityRow
} from '../../../../../shared/bots/bot-activity-model'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { automationOwnerForHostId, evaluateAutomationOwner } from './automation-host-owner'

import type { BotAutomationFacts } from '../../../../../shared/bots/bot-automation-rows'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../../shared/bots/bot-chat-tree'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'

const origin = Symbol('bot-record-owner')
type OwnedRecord = (
  | BotAutomationFacts
  | BotSessionActivityRow
  | BotChatTreeChat
  | BotChatTreeWorker
  | BotItemLinkView
) & { [origin]?: AutomationOwnerRef | null }

/** Renderer-only provenance survives derived row spreads, never a wire record. */
export function qualifyBotRecord<T extends OwnedRecord>(
  record: T,
  owner: AutomationOwnerRef | null
): T {
  const tagged = record
  if (origin in tagged && JSON.stringify(tagged[origin]) === JSON.stringify(owner)) {
    return record
  }
  return Object.assign({ ...record }, { [origin]: owner })
}

export function inheritBotRecordOwner<T extends OwnedRecord>(source: OwnedRecord, derived: T): T {
  return qualifyBotRecord(derived, botAutomationRowOwner(source))
}

export function captureBotRecordOwner(bot: BotRef): <T extends OwnedRecord>(record: T) => T {
  const owner = automationOwnerForHostId(bot.hostId, useAppStore.getState())
  return (record) => qualifyBotRecord(record, owner)
}

/** Capture before acquisition, and never retag an old publication when its IDs are reused. */
export function captureBotAutomationOwners(bot: BotRef): (activity: BotActivity) => BotActivity {
  const qualify = captureBotRecordOwner(bot)
  return (activity) => ({
    ...activity,
    automations: activity.automations.map((row) => ({
      ...row,
      automation: qualify(row.automation)
    })),
    waits: activity.waits.map((row) => ({ ...row, automation: qualify(row.automation) })),
    inProgress: activity.inProgress.map(qualify),
    completed: activity.completed.map(qualify)
  })
}

export function botAutomationRowOwner(
  record: OwnedRecord,
  _bot?: BotRef
): AutomationOwnerRef | null {
  return record[origin] ?? null
}

export async function actOnBotAutomationRow<T>(
  owner: AutomationOwnerRef | null,
  action: (owner: AutomationOwnerRef) => Promise<T>,
  bot?: BotRef
): Promise<T> {
  if (!owner) {
    throw new Error('Refresh this automation before trying again.')
  }
  const current = evaluateAutomationOwner(owner)
  if (current.status !== 'same' && current.status !== 'continued') {
    throw new Error('This computer changed. Refresh this automation before trying again.')
  }
  if (bot) {
    const target = automationOwnerForHostId(bot.hostId, useAppStore.getState())
    if (JSON.stringify(target) !== JSON.stringify(current.owner)) {
      throw new Error('This computer changed. Refresh this automation before trying again.')
    }
  }
  return await action(current.owner)
}
