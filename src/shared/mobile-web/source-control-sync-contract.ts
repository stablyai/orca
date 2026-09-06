import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './bridge-operation-contract'
import {
  MobileWebGitObjectIdSchema,
  MobileWebGitRefNameSchema
} from './source-control-history-contract'

const NullableGitObjectIdSchema = MobileWebGitObjectIdSchema.nullable()
const NullableGitRefNameSchema = MobileWebGitRefNameSchema.nullable()
const UpstreamNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('://') &&
      !/^[A-Za-z]:/.test(value),
    'Invalid upstream name'
  )

export const MobileWebSourceControlUpstreamSnapshotSchema = z
  .object({
    hasUpstream: z.boolean(),
    upstreamName: UpstreamNameSchema.optional(),
    ahead: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    behind: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    hasConfiguredPushTarget: z.boolean(),
    behindCommitsArePatchEquivalent: z.boolean()
  })
  .strict()

export const MobileWebSourceControlRepositoryStateSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    head: NullableGitObjectIdSchema,
    branch: NullableGitRefNameSchema,
    conflictOperation: z.enum(['merge', 'rebase', 'cherry-pick', 'unknown']),
    baseRef: NullableGitRefNameSchema,
    upstream: MobileWebSourceControlUpstreamSnapshotSchema
  })
  .strict()

export const MobileWebSourceControlUpstreamPayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

const ExpectedRepositoryShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  expectedHead: NullableGitObjectIdSchema,
  expectedBranch: NullableGitRefNameSchema
} as const

const ExpectedRemoteRepositoryShape = {
  ...ExpectedRepositoryShape,
  expectedUpstream: MobileWebSourceControlUpstreamSnapshotSchema
} as const

export const MobileWebSourceControlCheckoutPayloadSchema = z
  .object({
    ...ExpectedRepositoryShape,
    branch: MobileWebGitRefNameSchema,
    confirmation: z.literal('checkout-confirmed')
  })
  .strict()

export const MobileWebSourceControlFetchPayloadSchema = z.object(ExpectedRepositoryShape).strict()

export const MobileWebSourceControlPullPayloadSchema = z
  .object({
    ...ExpectedRemoteRepositoryShape,
    strategy: z.enum(['fast-forward', 'merge']),
    confirmation: z.literal('pull-confirmed')
  })
  .strict()

export const MobileWebSourceControlPushPayloadSchema = z
  .object({
    ...ExpectedRemoteRepositoryShape,
    mode: z.enum(['push', 'publish']),
    confirmation: z.literal('push-confirmed')
  })
  .strict()

export const MobileWebSourceControlRebasePayloadSchema = z
  .object({
    ...ExpectedRemoteRepositoryShape,
    baseRef: MobileWebGitRefNameSchema,
    confirmation: z.literal('rebase-confirmed')
  })
  .strict()

export const MobileWebSourceControlAbortPayloadSchema = z
  .object({
    ...ExpectedRepositoryShape,
    conflictOperation: z.enum(['merge', 'rebase']),
    confirmation: z.literal('abort-confirmed')
  })
  .strict()

export const MobileWebSourceControlSyncOperationSchema = z.enum([
  'branch',
  'fetch',
  'pull',
  'push',
  'rebase',
  'abort'
])

const MobileWebSourceControlSyncResultShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  previousHead: NullableGitObjectIdSchema,
  previousBranch: NullableGitRefNameSchema,
  repository: MobileWebSourceControlRepositoryStateSchema.nullable(),
  completed: z.literal(true)
} as const

export const MobileWebSourceControlSyncResultSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...MobileWebSourceControlSyncResultShape,
      operation: z.literal('branch'),
      branch: MobileWebGitRefNameSchema
    })
    .strict(),
  z
    .object({
      ...MobileWebSourceControlSyncResultShape,
      operation: z.enum(['fetch', 'pull', 'push', 'rebase', 'abort'])
    })
    .strict()
])

export type MobileWebSourceControlUpstreamSnapshot = z.infer<
  typeof MobileWebSourceControlUpstreamSnapshotSchema
>
export type MobileWebSourceControlRepositoryState = z.infer<
  typeof MobileWebSourceControlRepositoryStateSchema
>
export type MobileWebSourceControlUpstreamPayload = z.infer<
  typeof MobileWebSourceControlUpstreamPayloadSchema
>
export type MobileWebSourceControlCheckoutPayload = z.infer<
  typeof MobileWebSourceControlCheckoutPayloadSchema
>
export type MobileWebSourceControlFetchPayload = z.infer<
  typeof MobileWebSourceControlFetchPayloadSchema
>
export type MobileWebSourceControlPullPayload = z.infer<
  typeof MobileWebSourceControlPullPayloadSchema
>
export type MobileWebSourceControlPushPayload = z.infer<
  typeof MobileWebSourceControlPushPayloadSchema
>
export type MobileWebSourceControlRebasePayload = z.infer<
  typeof MobileWebSourceControlRebasePayloadSchema
>
export type MobileWebSourceControlAbortPayload = z.infer<
  typeof MobileWebSourceControlAbortPayloadSchema
>
export type MobileWebSourceControlSyncOperation = z.infer<
  typeof MobileWebSourceControlSyncOperationSchema
>
export type MobileWebSourceControlSyncResult = z.infer<
  typeof MobileWebSourceControlSyncResultSchema
>
