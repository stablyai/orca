// ARCHIVE-HOOK wire: POST/GET /v1/sandboxes/:id/archive-hook (cloud/apps/sandbox-control/src/archive-hook-route.ts).
import { z } from 'zod'

/** What the control plane last learned about a workspace's orca.yaml archive hook. */
export const HostedArchiveHookMemoSchema = z.enum(['none', 'pending', 'done'])
export type HostedArchiveHookMemo = z.infer<typeof HostedArchiveHookMemoSchema>

const HostedArchiveHookRunSchema = z.object({
  path: z.string().max(4096),
  /** Null when no exit was observed (it timed out). */
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  output: z.string().max(64 * 1024)
})
export type HostedArchiveHookRun = z.infer<typeof HostedArchiveHookRunSchema>

/**
 * POST /v1/sandboxes/:id/archive-hook. `asleep`: not run, and the hook may exist (`memo`); the
 * caller decides whether to wake it. `already_ran`: it succeeded since the workspace last woke.
 */
export const HostedArchiveHookResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_configured') }),
  z.object({ state: z.literal('already_ran') }),
  z.object({ state: z.literal('asleep'), memo: HostedArchiveHookMemoSchema.nullable() }),
  z.object({
    state: z.enum(['succeeded', 'failed']),
    runs: z.array(HostedArchiveHookRunSchema).max(20),
    reason: z.enum(['no_server', 'no_answer', 'unreachable', 'busy', 'wake_failed']).optional()
  })
])
export type HostedArchiveHookResult = z.infer<typeof HostedArchiveHookResultSchema>
export type HostedArchiveHookFailure = Extract<HostedArchiveHookResult, { runs: unknown }> & {
  state: 'failed'
}
export const HostedArchiveHookResponseSchema = z.object({
  archiveHook: HostedArchiveHookResultSchema
})
export const HostedArchiveHookStateResponseSchema = z.object({
  archiveHook: z.object({
    memo: HostedArchiveHookMemoSchema.nullable(),
    running: z.boolean(),
    archived: z.boolean().optional()
  })
})
