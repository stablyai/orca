// Ordered backup models for a bot when its primary model hits a usage limit, plus active failover state.
import * as z from 'zod'
import { readAgentSessionExecutionOptions } from '../agent-session/options/protocol/agent-session-execution-options'
import { OptionKey } from '../rpc-contract/agent-launch/agent-launch-settings-params'
import { BOT_AGENTS, type BotAgent } from './bot-agents'
import type { BotLaunch } from './bot-launch'

export const BOT_BACKUP_MODEL_LIMIT = 8

const ChoiceValue = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0') && !/\p{Cc}/u.test(value), 'Invalid option value')

export const BotBackupModelEntrySchema = z
  .object({
    agent: z.enum(BOT_AGENTS),
    model: ChoiceValue.optional(),
    options: z
      .record(OptionKey, ChoiceValue)
      .refine((value) => Object.keys(value).length <= 32)
      .optional()
  })
  .strict()
  .refine(
    (entry) =>
      readAgentSessionExecutionOptions({
        ...entry.options,
        ...(entry.model ? { model: entry.model } : {})
      }) !== null,
    'Invalid backup model choice'
  )

export type BotBackupModelEntry = z.infer<typeof BotBackupModelEntrySchema>

export const BotBackupModelsSchema = z
  .object({
    /** true: switch automatically on usage limit; false: ask in chat first. */
    automatic: z.boolean(),
    order: z.array(BotBackupModelEntrySchema).max(BOT_BACKUP_MODEL_LIMIT)
  })
  .strict()

export type BotBackupModels = z.infer<typeof BotBackupModelsSchema>

/** Active failover state while a bot is running on a backup until its primary limit resets. */
export const BotActiveBackupSchema = z
  .object({
    target: BotBackupModelEntrySchema,
    switchedAt: z.number().int().nonnegative(),
    /** Primary model that hit the limit (needed when bot.launch.model was unset/default). */
    primaryModel: ChoiceValue.optional(),
    /** Primary limit reset timestamp (epoch ms), when known. */
    primaryResetsAt: z.number().int().positive().optional()
  })
  .strict()

export type BotActiveBackup = z.infer<typeof BotActiveBackupSchema>

export type BotBackupModelAvailability = 'ready' | 'at-limit' | 'unavailable'

export type BotBackupModelStatusEntry = {
  entry: BotBackupModelEntry
  state: BotBackupModelAvailability
  resetsAt?: number
}

export type BotBackupEffortChoice = {
  value: string
  label: string
}

export type BotBackupCatalogOption = {
  agent: BotAgent
  model?: string
  label: string
  efforts?: BotBackupEffortChoice[]
  defaultEffort?: string
  state: BotBackupModelAvailability
  resetsAt?: number
}

export type BotBackupStatusResult = {
  botId: string
  primary: {
    agent: BotAgent
    model?: string
    state: BotBackupModelAvailability
    resetsAt?: number
  }
  backupModels: BotBackupModels | null
  activeBackup: BotActiveBackup | null
  entries: BotBackupModelStatusEntry[]
  /** Installed & chat-capable models across agents for picker UIs (excludes no credentials/paths). */
  availableOptions: BotBackupCatalogOption[]
}

const BotBackupAvailabilitySchema = z.enum(['ready', 'at-limit', 'unavailable'])

export const BotBackupStatusResultSchema: z.ZodType<BotBackupStatusResult> = z.looseObject({
  botId: z.string().min(1),
  primary: z.looseObject({
    agent: z.enum(BOT_AGENTS),
    model: z.string().min(1).optional(),
    state: BotBackupAvailabilitySchema,
    resetsAt: z.number().optional()
  }),
  backupModels: BotBackupModelsSchema.nullable(),
  activeBackup: BotActiveBackupSchema.nullable(),
  entries: z.array(
    z.looseObject({
      entry: BotBackupModelEntrySchema,
      state: BotBackupAvailabilitySchema,
      resetsAt: z.number().optional()
    })
  ),
  availableOptions: z.array(
    z.looseObject({
      agent: z.enum(BOT_AGENTS),
      model: z.string().min(1).optional(),
      label: z.string().min(1),
      efforts: z
        .array(z.looseObject({ value: z.string().min(1), label: z.string().min(1) }))
        .optional(),
      defaultEffort: z.string().min(1).optional(),
      state: BotBackupAvailabilitySchema,
      resetsAt: z.number().optional()
    })
  )
})

export const BotBackupStatusParamsSchema = z
  .object({
    botId: z.string().min(1).max(128)
  })
  .strict()

export const BotBackupSwitchParamsSchema = z
  .object({
    botId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    turnItemId: z.string().min(1).max(256),
    target: BotBackupModelEntrySchema,
    /** When true, promotes `target` into `backupModels.order` and enables automatic failover. */
    remember: z.boolean().optional()
  })
  .strict()

export const BotBackupReturnParamsSchema = z
  .object({
    botId: z.string().min(1).max(128)
  })
  .strict()

export type BotBackupStatusParams = z.infer<typeof BotBackupStatusParamsSchema>
export type BotBackupSwitchParams = z.infer<typeof BotBackupSwitchParamsSchema>
export type BotBackupReturnParams = z.infer<typeof BotBackupReturnParamsSchema>

/** Identity key for comparing two bot model choices (`agent` + normalized `model`). */
export function botModelTargetKey(target: Pick<BotBackupModelEntry, 'agent' | 'model'>): string {
  return `${target.agent}\u0000${target.model ?? ''}`
}

export function sameBotModelTarget(
  left: Pick<BotBackupModelEntry, 'agent' | 'model'> | undefined,
  right: Pick<BotBackupModelEntry, 'agent' | 'model'> | undefined
): boolean {
  if (!left || !right) {
    return false
  }
  return left.agent === right.agent && (left.model ?? '') === (right.model ?? '')
}

export function botPrimaryTarget(bot: {
  agent: BotAgent
  launch?: BotLaunch
}): BotBackupModelEntry {
  return {
    agent: bot.agent,
    ...(bot.launch?.model ? { model: bot.launch.model } : {}),
    ...(bot.launch?.options && Object.keys(bot.launch.options).length > 0
      ? { options: { ...bot.launch.options } }
      : {})
  }
}

export {
  addBotBackupModel,
  applyBotBackupModelUpdates,
  backupEntryToLaunch,
  effectiveBotSetup,
  normalizeBotBackupModels,
  rememberedBotBackupModels,
  removeBotBackupModel,
  reorderBotBackupModels,
  updateBotBackupModelEffort
} from './bot-backup-model-order'
