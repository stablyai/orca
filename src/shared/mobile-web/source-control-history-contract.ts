import { z } from 'zod'
import {
  MobileWebRelativePathSchema,
  MobileWebWorkspaceIdSchema
} from './bridge-operation-contract'
import { isMobileWebGitObjectId, isMobileWebSha256 } from './protocol-token-contract'

export const MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT = 128
export const MOBILE_WEB_SOURCE_CONTROL_HISTORY_DEFAULT_LIMIT = 50
export const MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT = 100
export const MOBILE_WEB_SOURCE_CONTROL_HISTORY_PARENT_LIMIT = 16
export const MOBILE_WEB_SOURCE_CONTROL_HISTORY_REFERENCE_LIMIT = 32
export const MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT = 128
export const MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES = 4_000
export const MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES = 192 * 1024
export const MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES = 192 * 1024

export const MobileWebGitObjectIdSchema = z.string().refine(isMobileWebGitObjectId)

export const MobileWebGitRefNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => !value.startsWith('-') && !value.includes('\0'), 'Invalid Git ref')

export const MobileWebSourceControlBranchesPayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

export const MobileWebSourceControlBranchesResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    current: MobileWebGitRefNameSchema.nullable(),
    branches: z.array(MobileWebGitRefNameSchema).max(MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT),
    totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    truncated: z.boolean()
  })
  .strict()

export const MobileWebSourceControlHistoryPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT)
      .default(MOBILE_WEB_SOURCE_CONTROL_HISTORY_DEFAULT_LIMIT),
    baseRef: MobileWebGitRefNameSchema.optional()
  })
  .strict()

export const MobileWebSourceControlHistoryRefSchema = z
  .object({
    id: z.string().min(1).max(320),
    name: z.string().min(1).max(240),
    revision: MobileWebGitObjectIdSchema.optional(),
    category: z.enum(['branches', 'remote branches', 'tags', 'commits']).optional(),
    description: z.string().max(512).optional()
  })
  .strict()

export const MobileWebSourceControlHistoryItemSchema = z
  .object({
    id: MobileWebGitObjectIdSchema,
    parentIds: z
      .array(MobileWebGitObjectIdSchema)
      .max(MOBILE_WEB_SOURCE_CONTROL_HISTORY_PARENT_LIMIT),
    displayId: z.string().min(1).max(64),
    subject: z.string().min(1).max(512),
    message: z.string().max(8 * 1024),
    author: z.string().max(256).optional(),
    timestamp: z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000).optional(),
    references: z
      .array(MobileWebSourceControlHistoryRefSchema)
      .max(MOBILE_WEB_SOURCE_CONTROL_HISTORY_REFERENCE_LIMIT)
  })
  .strict()

export const MobileWebSourceControlHistoryResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    items: z
      .array(MobileWebSourceControlHistoryItemSchema)
      .max(MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT),
    currentRef: MobileWebSourceControlHistoryRefSchema.optional(),
    remoteRef: MobileWebSourceControlHistoryRefSchema.optional(),
    baseRef: MobileWebSourceControlHistoryRefSchema.optional(),
    mergeBase: MobileWebGitObjectIdSchema.optional(),
    hasIncomingChanges: z.boolean(),
    hasOutgoingChanges: z.boolean(),
    hasMore: z.boolean(),
    limit: z.number().int().min(1).max(MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT)
  })
  .strict()

export const MobileWebSourceControlBranchComparePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    baseRef: MobileWebGitRefNameSchema,
    offset: z.number().int().min(0).max(MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES).default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT)
      .default(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT),
    expectedRevision: z.string().refine(isMobileWebSha256).optional()
  })
  .strict()

export const MobileWebSourceControlCommitComparePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    commitId: MobileWebGitObjectIdSchema
  })
  .strict()

export const MobileWebSourceControlCompareEntrySchema = z
  .object({
    relativePath: MobileWebRelativePathSchema,
    oldRelativePath: MobileWebRelativePathSchema.optional(),
    status: z.enum(['modified', 'added', 'deleted', 'renamed', 'copied']),
    added: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    removed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

export const MobileWebSourceControlBranchCompareResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    baseRef: MobileWebGitRefNameSchema,
    compareRef: z.string().min(1).max(240),
    baseOid: MobileWebGitObjectIdSchema.nullable(),
    headOid: MobileWebGitObjectIdSchema.nullable(),
    mergeBase: MobileWebGitObjectIdSchema.nullable(),
    changedFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    commitsAhead: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    status: z.enum(['ready', 'invalid-base', 'unborn-head', 'no-merge-base', 'error']),
    revision: z.string().refine(isMobileWebSha256),
    offset: z.number().int().min(0).max(MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES),
    totalEntries: z.number().int().min(0).max(MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES),
    entries: z
      .array(MobileWebSourceControlCompareEntrySchema)
      .max(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT),
    nextOffset: z
      .number()
      .int()
      .min(1)
      .max(MOBILE_WEB_SOURCE_CONTROL_COMPARE_MAX_ENTRIES)
      .nullable(),
    truncated: z.boolean()
  })
  .strict()

export const MobileWebSourceControlCommitCompareResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    commitId: MobileWebGitObjectIdSchema,
    commitOid: MobileWebGitObjectIdSchema.nullable(),
    parentOid: MobileWebGitObjectIdSchema.nullable(),
    compareRef: z.string().min(1).max(240),
    baseRef: z.string().min(1).max(240),
    changedFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: z.enum(['ready', 'invalid-commit', 'error']),
    entries: z
      .array(MobileWebSourceControlCompareEntrySchema)
      .max(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT),
    truncated: z.boolean()
  })
  .strict()

export type MobileWebSourceControlBranchesPayload = z.infer<
  typeof MobileWebSourceControlBranchesPayloadSchema
>
export type MobileWebSourceControlBranchesResult = z.infer<
  typeof MobileWebSourceControlBranchesResultSchema
>
export type MobileWebSourceControlHistoryPayload = z.infer<
  typeof MobileWebSourceControlHistoryPayloadSchema
>
export type MobileWebSourceControlHistoryRef = z.infer<
  typeof MobileWebSourceControlHistoryRefSchema
>
export type MobileWebSourceControlHistoryItem = z.infer<
  typeof MobileWebSourceControlHistoryItemSchema
>
export type MobileWebSourceControlHistoryResult = z.infer<
  typeof MobileWebSourceControlHistoryResultSchema
>
export type MobileWebSourceControlBranchComparePayload = z.infer<
  typeof MobileWebSourceControlBranchComparePayloadSchema
>
export type MobileWebSourceControlCommitComparePayload = z.infer<
  typeof MobileWebSourceControlCommitComparePayloadSchema
>
export type MobileWebSourceControlCompareEntry = z.infer<
  typeof MobileWebSourceControlCompareEntrySchema
>
export type MobileWebSourceControlBranchCompareResult = z.infer<
  typeof MobileWebSourceControlBranchCompareResultSchema
>
export type MobileWebSourceControlCommitCompareResult = z.infer<
  typeof MobileWebSourceControlCommitCompareResultSchema
>
