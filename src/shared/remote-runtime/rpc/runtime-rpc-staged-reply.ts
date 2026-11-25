import { z } from 'zod'

/**
 * A paired client that can fetch a reply larger than one frame in parts. Without it the host
 * answers `reply_too_large`; with it the host keeps the reply and answers `reply_staged`.
 */
export const RUNTIME_RPC_STAGED_REPLY_CLIENT_CAPABILITY = 'rpc.staged-reply.v1' as const

export const RUNTIME_RPC_REPLY_STAGED_CODE = 'reply_staged'
export const RUNTIME_RPC_READ_STAGED_REPLY_METHOD = 'rpc.readStagedReply'

// Same per-result cap as a This-device page's staged automation result.
export const RUNTIME_RPC_MAX_STAGED_REPLY_BYTES = 64 * 1024 * 1024

// Why: at most 3 UTF-8 bytes per UTF-16 unit of serialized JSON, so a part fits the 4 MiB reply.
export const RUNTIME_RPC_STAGED_REPLY_PART_CHARS = 1024 * 1024

/** The `reply_staged` error's data: the reply's serialized JSON is `length` UTF-16 units. */
// A UTF-16 unit is at least one UTF-8 byte, so a host can't make the reader keep more than the cap.
export const RuntimeRpcStagedReplyHandleSchema = z.object({
  replyId: z.string().min(1),
  length: z.number().int().positive().max(RUNTIME_RPC_MAX_STAGED_REPLY_BYTES)
})
export type RuntimeRpcStagedReplyHandle = z.infer<typeof RuntimeRpcStagedReplyHandleSchema>

export const RuntimeRpcReadStagedReplyParamsSchema = z.object({
  replyId: z.string(),
  offset: z.number().int().nonnegative()
})
export type RuntimeRpcReadStagedReplyParams = z.infer<typeof RuntimeRpcReadStagedReplyParamsSchema>

export type RuntimeRpcStagedReplyPart = { text: string }
