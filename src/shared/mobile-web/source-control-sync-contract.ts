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

export const MobileWebSourceControlRepositoryStatePayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

export const MobileWebSourceControlCheckoutPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    branch: MobileWebGitRefNameSchema
  })
  .strict()

export const MobileWebSourceControlSyncPayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

export const MobileWebSourceControlPullPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    strategy: z.enum(['fast-forward', 'merge'])
  })
  .strict()

export const MobileWebSourceControlPushPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    mode: z.enum(['push', 'publish'])
  })
  .strict()

export const MobileWebSourceControlRebasePayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    baseRef: MobileWebGitRefNameSchema
  })
  .strict()

export const MobileWebSourceControlAbortPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    conflictOperation: z.enum(['merge', 'rebase'])
  })
  .strict()

export type MobileWebSourceControlUpstreamSnapshot = z.infer<
  typeof MobileWebSourceControlUpstreamSnapshotSchema
>
export type MobileWebSourceControlRepositoryState = z.infer<
  typeof MobileWebSourceControlRepositoryStateSchema
>
export type MobileWebSourceControlRepositoryStatePayload = z.infer<
  typeof MobileWebSourceControlRepositoryStatePayloadSchema
>
export type MobileWebSourceControlCheckoutPayload = z.infer<
  typeof MobileWebSourceControlCheckoutPayloadSchema
>
export type MobileWebSourceControlSyncPayload = z.infer<
  typeof MobileWebSourceControlSyncPayloadSchema
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
