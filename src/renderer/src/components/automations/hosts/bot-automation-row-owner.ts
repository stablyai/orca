import { useAppStore } from '@/store'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotActivity } from '../../../../../shared/bots/bot-activity-model'
import type { BotAutomationFacts } from '../../../../../shared/bots/bot-automation-rows'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { automationOwnerForHostId, evaluateAutomationOwner } from './automation-host-owner'

const owners = new WeakMap<object, AutomationOwnerRef | null>()

/** Capture before acquisition; equal rows keep their data identity, but a new owner republishes. */
export function captureBotAutomationOwners(bot: BotRef): (activity: BotActivity) => BotActivity {
  const owner = automationOwnerForHostId(bot.hostId, useAppStore.getState())
  return (activity) => {
    let changed = false
    for (const row of [...activity.automations, ...activity.waits]) {
      const previous = owners.get(row.automation)
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(owner)) {
        changed = true
      }
      owners.set(row.automation, owner)
    }
    return changed ? { ...activity } : activity
  }
}

export function botAutomationRowOwner(
  automation: BotAutomationFacts,
  bot: BotRef
): AutomationOwnerRef | null {
  const captured = owners.get(automation)
  if (captured !== undefined) {
    return captured
  }
  const current = automationOwnerForHostId(bot.hostId, useAppStore.getState())
  return current?.authority.kind === 'desktop' ? current : null
}

export async function actOnBotAutomationRow<T>(
  owner: AutomationOwnerRef | null,
  action: (owner: AutomationOwnerRef) => Promise<T>
): Promise<T> {
  if (!owner) {
    throw new Error('Refresh this automation before trying again.')
  }
  const current = evaluateAutomationOwner(owner)
  if (current.status !== 'same' && current.status !== 'continued') {
    throw new Error('This computer changed. Refresh this automation before trying again.')
  }
  return await action(current.owner)
}
