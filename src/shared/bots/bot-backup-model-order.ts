// Pure list mutations and failover-setup resolution for a bot's ordered backup models.
import type { BotAgent } from './bot-agents'
import { botLaunchFromChoices, type BotLaunch } from './bot-launch'
import {
  BOT_BACKUP_MODEL_LIMIT,
  botModelTargetKey,
  botPrimaryTarget,
  sameBotModelTarget,
  type BotActiveBackup,
  type BotBackupModelEntry,
  type BotBackupModels
} from './bot-backup-models'

export function backupEntryToLaunch(entry: BotBackupModelEntry): BotLaunch | undefined {
  return botLaunchFromChoices({
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.options ? { options: entry.options } : {})
  })
}

function cleanBackupEntry(entry: BotBackupModelEntry): BotBackupModelEntry {
  const launch = backupEntryToLaunch(entry)
  return {
    agent: entry.agent,
    ...(launch?.model ? { model: launch.model } : {}),
    ...(launch?.options ? { options: launch.options } : {})
  }
}

/** Deduplicates entries, strips any matching `primary`, caps at 8, and drops empty configs. */
export function normalizeBotBackupModels(
  config: BotBackupModels | null | undefined,
  primary?: Pick<BotBackupModelEntry, 'agent' | 'model'>
): BotBackupModels | undefined {
  if (!config) {
    return undefined
  }
  const seen = new Set<string>()
  const primaryKey = primary ? botModelTargetKey(primary) : null
  const order: BotBackupModelEntry[] = []
  for (const raw of config.order) {
    const entry = cleanBackupEntry(raw)
    const key = botModelTargetKey(entry)
    if (seen.has(key) || (primaryKey !== null && key === primaryKey)) {
      continue
    }
    seen.add(key)
    order.push(entry)
    if (order.length >= BOT_BACKUP_MODEL_LIMIT) {
      break
    }
  }
  if (order.length === 0) {
    return undefined
  }
  return { automatic: config.automatic, order }
}

/** Appends a backup model; defaults to `automatic: true` when initializing from none. */
export function addBotBackupModel(
  current: BotBackupModels | undefined,
  entry: BotBackupModelEntry,
  primary?: Pick<BotBackupModelEntry, 'agent' | 'model'>
): BotBackupModels | undefined {
  return normalizeBotBackupModels(
    {
      automatic: current?.automatic ?? true,
      order: [...(current?.order ?? []), entry]
    },
    primary
  )
}

export function removeBotBackupModel(
  current: BotBackupModels | undefined,
  index: number
): BotBackupModels | undefined {
  if (!current || index < 0 || index >= current.order.length) {
    return current
  }
  const order = current.order.filter((_, position) => position !== index)
  return order.length > 0 ? { automatic: current.automatic, order } : undefined
}

export function reorderBotBackupModels(
  current: BotBackupModels | undefined,
  fromIndex: number,
  toIndex: number
): BotBackupModels | undefined {
  if (
    !current ||
    fromIndex < 0 ||
    fromIndex >= current.order.length ||
    toIndex < 0 ||
    toIndex >= current.order.length ||
    fromIndex === toIndex
  ) {
    return current
  }
  const order = [...current.order]
  const [moved] = order.splice(fromIndex, 1)
  if (!moved) {
    return current
  }
  order.splice(toIndex, 0, moved)
  return { automatic: current.automatic, order }
}

/** Updates or clears the reasoning effort option on the backup entry at `index`. */
export function updateBotBackupModelEffort(
  current: BotBackupModels | undefined,
  index: number,
  effort: string | undefined
): BotBackupModels | undefined {
  if (!current || index < 0 || index >= current.order.length) {
    return current
  }
  const order = current.order.map((entry, position) => {
    if (position !== index) {
      return entry
    }
    const nextOptions = { ...entry.options }
    if (effort) {
      nextOptions.effort = effort
    } else {
      delete nextOptions.effort
    }
    return cleanBackupEntry({
      agent: entry.agent,
      ...(entry.model ? { model: entry.model } : {}),
      ...(Object.keys(nextOptions).length > 0 ? { options: nextOptions } : {})
    })
  })
  return { automatic: current.automatic, order }
}

/** Promotes `chosen` to the front of `order` and enables automatic failover. */
export function rememberedBotBackupModels(
  chosen: BotBackupModelEntry,
  current: BotBackupModels | undefined,
  primary?: Pick<BotBackupModelEntry, 'agent' | 'model'>
): BotBackupModels | undefined {
  const rest = (current?.order ?? []).filter((entry) => !sameBotModelTarget(entry, chosen))
  return normalizeBotBackupModels({ automatic: true, order: [chosen, ...rest] }, primary)
}

/** Resolves the effective setup a bot should launch with: its active backup if set, else its primary. */
export function effectiveBotSetup(bot: {
  agent: BotAgent
  launch?: BotLaunch
  activeBackup?: BotActiveBackup
}): { agent: BotAgent; launch?: BotLaunch; onBackup: boolean } {
  if (!bot.activeBackup) {
    return { agent: bot.agent, ...(bot.launch ? { launch: bot.launch } : {}), onBackup: false }
  }
  const launch = backupEntryToLaunch(bot.activeBackup.target)
  return {
    agent: bot.activeBackup.target.agent,
    ...(launch ? { launch } : {}),
    onBackup: true
  }
}

/** Applies backupModels and host-only activeBackup mutations while preserving primary invariants. */
export function applyBotBackupModelUpdates<
  T extends {
    agent: BotAgent
    launch?: BotLaunch
    backupModels?: BotBackupModels
    activeBackup?: BotActiveBackup
  }
>(
  next: T,
  input: {
    backupModels?: BotBackupModels | null
    activeBackup?: BotActiveBackup | null
    primaryChanged: boolean
  }
): void {
  const primary = botPrimaryTarget(next)
  if (input.backupModels === null) {
    delete next.backupModels
  } else if (input.backupModels !== undefined || (input.primaryChanged && next.backupModels)) {
    const normalized = normalizeBotBackupModels(input.backupModels ?? next.backupModels, primary)
    if (normalized) {
      next.backupModels = normalized
    } else {
      delete next.backupModels
    }
  }
  if (input.activeBackup === null) {
    delete next.activeBackup
  } else if (input.activeBackup !== undefined) {
    next.activeBackup = input.activeBackup
  } else if (input.primaryChanged) {
    delete next.activeBackup
  }
}
