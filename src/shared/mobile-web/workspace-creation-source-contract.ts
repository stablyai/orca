import { z } from 'zod'
import { MobileWebCreationRepoIdSchema } from './workspace-creation-read-contract'

const QuerySchema = z.string().max(2048)
const TitleSchema = z.string().min(1).max(512)
const UrlSchema = z.string().url().max(2048)
const OptionalBranchSchema = z.string().min(1).max(512).optional()
const IssueNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const MobileWebCreationRepoQueryPayloadSchema = z
  .object({ repoId: MobileWebCreationRepoIdSchema, query: QuerySchema })
  .strict()
export const MobileWebCreationGitLabSearchPayloadSchema =
  MobileWebCreationRepoQueryPayloadSchema.extend({
    state: z.enum(['opened', 'merged', 'closed', 'all'])
  }).strict()
export const MobileWebCreationLinearSearchPayloadSchema = z
  .object({
    query: QuerySchema,
    linearWorkspaceId: z.string().min(1).max(256).nullable().optional()
  })
  .strict()

export const MobileWebCreationGitHubItemSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.enum(['issue', 'pr']),
    number: IssueNumberSchema,
    title: TitleSchema,
    state: z.enum(['open', 'closed', 'merged', 'draft']),
    url: UrlSchema,
    labels: z.array(z.string().max(120)).max(100),
    updatedAt: z.string().max(80),
    author: z.string().max(160).nullable(),
    branchName: OptionalBranchSchema,
    baseRefName: OptionalBranchSchema,
    isCrossRepository: z.boolean().optional(),
    repoId: MobileWebCreationRepoIdSchema
  })
  .strict()

export const MobileWebCreationGitLabItemSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.enum(['issue', 'mr']),
    number: IssueNumberSchema,
    title: TitleSchema,
    state: z.enum(['opened', 'closed', 'merged', 'locked', 'draft']),
    url: UrlSchema,
    labels: z.array(z.string().max(120)).max(100),
    updatedAt: z.string().max(80),
    author: z.string().max(160).nullable(),
    branchName: OptionalBranchSchema,
    baseRefName: OptionalBranchSchema,
    isCrossRepository: z.boolean().optional(),
    repoId: MobileWebCreationRepoIdSchema
  })
  .strict()

export const MobileWebCreationLinearIssueSchema = z
  .object({
    id: z.string().min(1).max(256),
    workspaceId: z.string().min(1).max(256).optional(),
    identifier: z.string().min(1).max(80),
    title: TitleSchema,
    branchName: OptionalBranchSchema,
    url: UrlSchema,
    state: z
      .object({
        name: z.string().max(120),
        type: z.string().max(80),
        color: z.string().max(64)
      })
      .strict(),
    team: z
      .object({
        id: z.string().min(1).max(256),
        name: z.string().max(160),
        key: z.string().max(40)
      })
      .strict(),
    labels: z.array(z.string().max(120)).max(100),
    labelIds: z.array(z.string().max(256)).max(100),
    priority: z.number().int().min(0).max(10),
    updatedAt: z.string().max(80)
  })
  .strict()

export const MobileWebCreationGitHubSearchResultSchema = z
  .object({ items: z.array(MobileWebCreationGitHubItemSchema).max(50) })
  .strict()
export const MobileWebCreationGitLabSearchResultSchema = z
  .object({ items: z.array(MobileWebCreationGitLabItemSchema).max(50) })
  .strict()
export const MobileWebCreationLinearSearchResultSchema = z
  .object({ issues: z.array(MobileWebCreationLinearIssueSchema).max(50) })
  .strict()

export const MobileWebCreationBranchResultSchema = z
  .object({
    refName: z.string().min(1).max(512),
    localBranchName: z.string().max(512)
  })
  .strict()
export const MobileWebCreationBranchSearchResultSchema = z
  .object({ branches: z.array(MobileWebCreationBranchResultSchema).max(20) })
  .strict()

export const MobileWebCreationRepoSlugResultSchema = z
  .object({
    supported: z.boolean(),
    slug: z
      .object({
        owner: z.string().min(1).max(256),
        repo: z.string().min(1).max(256),
        host: z.string().min(1).max(256).optional()
      })
      .strict()
      .nullable()
  })
  .strict()
export const MobileWebCreationGitHubLookupPayloadSchema = z
  .object({ repoId: MobileWebCreationRepoIdSchema, number: IssueNumberSchema })
  .strict()
export const MobileWebCreationGitHubRepoLookupPayloadSchema = z
  .object({
    repoId: MobileWebCreationRepoIdSchema,
    slug: MobileWebCreationRepoSlugResultSchema.shape.slug.unwrap(),
    number: IssueNumberSchema,
    type: z.enum(['issue', 'pr'])
  })
  .strict()
export const MobileWebCreationGitLabLookupPayloadSchema = z
  .object({
    repoId: MobileWebCreationRepoIdSchema,
    host: z.string().min(1).max(256),
    path: z.string().min(1).max(1024),
    iid: IssueNumberSchema,
    type: z.enum(['issue', 'mr'])
  })
  .strict()
export const MobileWebCreationGitHubLookupResultSchema = z
  .object({ item: MobileWebCreationGitHubItemSchema.nullable() })
  .strict()
export const MobileWebCreationGitLabLookupResultSchema = z
  .object({ item: MobileWebCreationGitLabItemSchema.nullable() })
  .strict()

const HostedBaseShape = {
  baseBranch: z.string().min(1).max(512),
  compareBaseRef: z.string().min(1).max(512).optional(),
  pushTarget: z
    .object({
      remoteName: z.string().min(1).max(256),
      branchName: z.string().min(1).max(512)
    })
    .strict()
    .optional(),
  branchNameOverride: z.string().min(1).max(512).optional(),
  maintainerCanModify: z.boolean().optional()
} as const
export const MobileWebCreationHostedBaseResultSchema = z.object(HostedBaseShape).strict()
export const MobileWebCreationPrBasePayloadSchema = z
  .object({
    repoId: MobileWebCreationRepoIdSchema,
    prNumber: IssueNumberSchema,
    headRefName: OptionalBranchSchema,
    baseRefName: OptionalBranchSchema,
    isCrossRepository: z.boolean().optional()
  })
  .strict()
export const MobileWebCreationMrBasePayloadSchema = z
  .object({
    repoId: MobileWebCreationRepoIdSchema,
    mrIid: IssueNumberSchema,
    sourceBranch: OptionalBranchSchema,
    targetBranch: OptionalBranchSchema,
    isCrossRepository: z.boolean().optional()
  })
  .strict()

export type MobileWebCreationGitHubItem = z.infer<typeof MobileWebCreationGitHubItemSchema>
export type MobileWebCreationGitLabItem = z.infer<typeof MobileWebCreationGitLabItemSchema>
export type MobileWebCreationLinearIssue = z.infer<typeof MobileWebCreationLinearIssueSchema>
export type MobileWebCreationHostedBaseResult = z.infer<
  typeof MobileWebCreationHostedBaseResultSchema
>
