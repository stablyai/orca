import * as z from 'zod'

export const commanderAccount = z.object({
  profileId: z.string().min(1),
  userId: z.string().min(1),
  activeOrgId: z.string().min(1).nullable()
})
export type CommanderAccount = z.infer<typeof commanderAccount>
export const commanderMemoryId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
export const commanderRecurringAnswerSetting = z.object({
  enabled: z.boolean(),
  version: z.number().int().nonnegative()
})
export const commanderRecurringAnswerChange = z.strictObject({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative()
})
export const commanderPreferenceResult = z.discriminatedUnion('matched', [
  z.object({
    matched: z.literal(true),
    answer: z.string().min(1).max(2000),
    rulePageId: commanderMemoryId,
    ruleVersion: z.number().int().positive(),
    decisionPageId: commanderMemoryId
  }),
  z.object({ matched: z.literal(false), reason: z.enum(['missing', 'conflict', 'disabled']) })
])
const actor = z.object({ type: z.enum(['human', 'agent', 'commander']), id: z.string() })
const content = z.object({
  pageId: commanderMemoryId,
  kind: z.enum(['guideline', 'decision', 'note']),
  title: z.string(),
  body: z.string(),
  projectId: z.string().nullable().optional(),
  links: z.array(z.string())
})
const versionedWrite = z.object({
  pageId: commanderMemoryId,
  requestId: commanderMemoryId,
  expectedVersion: z.number().int().nonnegative()
})
export const commanderMemoryWrite = z.union([
  content
    .extend({
      ...versionedWrite.shape,
      links: z.array(z.string()).optional(),
      deleted: z.literal(false).optional()
    })
    .strict(),
  versionedWrite.extend({ deleted: z.literal(true) }).strict()
])
export const commanderMemoryRevision = content.extend({
  recurringAnswerReceipt: z.literal(true).optional(),
  version: z.number().int().positive(),
  actor,
  createdBy: actor,
  deleted: z.boolean(),
  createdAt: z.string()
})
export const commanderMemoryList = z.object({ pages: z.array(commanderMemoryRevision) })
export const commanderMemorySummary = commanderMemoryRevision
  .omit({ body: true, links: true })
  .extend({ recurringQuestion: z.string().optional() })
export const commanderMemoryIndexQuery = z.strictObject({
  order: z.enum(['id', 'recent']).optional(),
  after: z.string().min(1).max(160).optional(),
  projectId: z.string().min(1).max(256).optional(),
  kind: content.shape.kind.optional(),
  includeDeleted: z.boolean().optional(),
  includeDeletedProjects: z.boolean().optional(),
  handoffsOnly: z.boolean().optional(),
  validHandoffsOnly: z.boolean().optional(),
  recurringOnly: z.boolean().optional(),
  q: z.string().max(512).optional(),
  ids: z.array(commanderMemoryId).min(1).max(50).optional()
})
export const commanderMemoryIndexResult = z.object({
  pages: z.array(commanderMemorySummary).max(50),
  projects: z.array(z.string()),
  next: z.string().nullable()
})
export const commanderWorkerProject = z
  .string()
  .min(1)
  .max(256)
  .refine((id) => !!id.trim())
export const commanderWorkerGuidance = z.object({
  guidelines: z
    .array(z.string().max(8000))
    .refine((entries) => entries.reduce((size, entry) => size + entry.length + 2, 0) <= 8000),
  truncated: z.boolean()
})
export type CommanderWorkerGuidance = z.infer<typeof commanderWorkerGuidance>
export type CommanderMemorySummary = z.infer<typeof commanderMemorySummary>
export type CommanderMemoryIndexQuery = z.infer<typeof commanderMemoryIndexQuery>
export type CommanderMemoryIndexResult = z.infer<typeof commanderMemoryIndexResult>
export const commanderMemoryPage = z.object({ page: commanderMemoryRevision })
export const commanderMemoryHistory = commanderMemoryPage.extend({
  history: z.array(commanderMemoryRevision),
  nextBeforeVersion: z.number().int().positive().nullable().optional()
})
export type CommanderMemoryRevision = z.infer<typeof commanderMemoryRevision>
export type CommanderMemoryWrite = z.infer<typeof commanderMemoryWrite>
export const commanderAgentGrantRequest = z
  .object({
    projectId: z.string().trim().min(1).max(256),
    type: z.enum(['agent', 'commander']).optional(),
    agentId: z.string().trim().min(1).max(128)
  })
  .strict()
export type CommanderRecoveryStatus = {
  enabled: boolean
  lastSyncedAt: number | null
  error: string | null
}
export type CommanderMemoryApi = {
  index(
    account: CommanderAccount,
    query: CommanderMemoryIndexQuery
  ): Promise<CommanderMemoryIndexResult>
  workerGuidance(account: CommanderAccount, projectId: string): Promise<CommanderWorkerGuidance>
  recurringAnswers(
    account: CommanderAccount,
    change?: z.infer<typeof commanderRecurringAnswerChange>
  ): Promise<z.infer<typeof commanderRecurringAnswerSetting>>
  agentRecovery(account: CommanderAccount, enabled?: boolean): Promise<CommanderRecoveryStatus>
  phoneSharing(account: CommanderAccount, enabled?: boolean): Promise<boolean>
  exportAgentGrant(
    account: CommanderAccount,
    grant: z.infer<typeof commanderAgentGrantRequest>
  ): Promise<{ saved: boolean; expiresAt?: string }>
  list(account: CommanderAccount): Promise<z.infer<typeof commanderMemoryList>>
  get(
    account: CommanderAccount,
    pageId: string,
    beforeVersion?: number
  ): Promise<z.infer<typeof commanderMemoryHistory>>
  save(
    account: CommanderAccount,
    write: CommanderMemoryWrite
  ): Promise<z.infer<typeof commanderMemoryPage>>
  checkpoint(
    account: CommanderAccount,
    write: CommanderMemoryWrite
  ): Promise<z.infer<typeof commanderMemoryPage>>
}
