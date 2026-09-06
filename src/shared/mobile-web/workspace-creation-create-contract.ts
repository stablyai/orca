import { z } from 'zod'
import { MobileWebCreationRepoIdSchema } from './workspace-creation-read-contract'

const NameSchema = z.string().min(1).max(160)
const OptionalTextSchema = z.string().max(4096).optional()
const BranchSchema = z.string().min(1).max(512)
const SetupDecisionSchema = z.enum(['inherit', 'run', 'skip'])
const AgentChoiceSchema = z.string().min(1).max(64)
const SparseCheckoutSchema = z
  .object({
    directories: z.array(z.string().min(1).max(4_096)).min(1).max(1_000),
    presetId: z.string().min(1).max(240).optional()
  })
  .strict()

const LinkedItemSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('github'),
      type: z.enum(['issue', 'pr']),
      number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      title: z.string().min(1).max(512),
      url: z.string().url().max(2048),
      repoId: MobileWebCreationRepoIdSchema
    })
    .strict(),
  z
    .object({
      provider: z.literal('gitlab'),
      type: z.enum(['issue', 'mr']),
      number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      title: z.string().min(1).max(512),
      url: z.string().url().max(2048),
      repoId: MobileWebCreationRepoIdSchema
    })
    .strict(),
  z
    .object({
      provider: z.literal('linear'),
      type: z.literal('issue'),
      number: z.literal(0),
      title: z.string().min(1).max(512),
      url: z.string().url().max(2048),
      linearIdentifier: z.string().min(1).max(80),
      linearBranchName: BranchSchema.optional()
    })
    .strict()
])

const WorkItemSelectionSchema = z
  .object({
    kind: z.literal('work-item'),
    item: LinkedItemSchema,
    baseBranch: BranchSchema.optional(),
    compareBaseRef: BranchSchema.optional(),
    pushTarget: z
      .object({
        remoteName: z.string().min(1).max(256),
        branchName: BranchSchema
      })
      .strict()
      .optional(),
    branchNameOverride: BranchSchema.optional()
  })
  .strict()
const BranchSelectionSchema = z
  .object({
    kind: z.literal('branch'),
    baseBranch: BranchSchema,
    refName: BranchSchema,
    localBranchName: BranchSchema,
    reuse: z.boolean(),
    branchNameOverride: BranchSchema.optional()
  })
  .strict()
const NewBranchSelectionSchema = z
  .object({ kind: z.literal('new-branch'), branchName: BranchSchema })
  .strict()

export const MobileWebCreationSelectionSchema = z.discriminatedUnion('kind', [
  WorkItemSelectionSchema,
  BranchSelectionSchema,
  NewBranchSelectionSchema
])

export const MobileWebCreationBlankPayloadSchema = z
  .object({
    repoId: MobileWebCreationRepoIdSchema,
    baseName: NameSchema,
    nameWasGenerated: z.boolean(),
    agentChoice: AgentChoiceSchema,
    comment: OptionalTextSchema,
    setupDecision: SetupDecisionSchema
  })
  .strict()

export const MobileWebCreationFromSourcePayloadSchema = z
  .object({
    selection: MobileWebCreationSelectionSchema,
    targetRepoId: MobileWebCreationRepoIdSchema,
    setupDecision: SetupDecisionSchema,
    agentChoice: AgentChoiceSchema,
    workspaceName: NameSchema.optional(),
    note: OptionalTextSchema,
    sparseCheckout: SparseCheckoutSchema.optional(),
    nameIsAutoManaged: z.boolean().optional()
  })
  .strict()

export const MobileWebCreationResultSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    name: NameSchema,
    warning: z.string().max(2_000).optional()
  })
  .strict()

export type MobileWebCreationBlankPayload = z.infer<typeof MobileWebCreationBlankPayloadSchema>
export type MobileWebCreationFromSourcePayload = z.infer<
  typeof MobileWebCreationFromSourcePayloadSchema
>
export type MobileWebCreationSelection = z.infer<typeof MobileWebCreationSelectionSchema>
export type MobileWebCreationResult = z.infer<typeof MobileWebCreationResultSchema>
