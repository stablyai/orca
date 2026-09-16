/**
 * The wire shape of `agent.launch`, mirroring `AgentLaunchIntent`.
 *
 * A caller states WHERE the agent lands and WHAT it should say; it never names a mode. There is
 * deliberately no `structured` / `terminal` field and no startup-agent field on the create
 * payload — the host decides, and `withoutReservedAgentCreateFields` strips a stale one out of a
 * payload a caller migrated over from `worktree.create`.
 *
 * Shared rather than main-side because every field resolves to a shared schema: a remote client
 * that sends this method needs `RpcSendParams<'agent.launch'>` to exist, and a method missing from
 * the catalog can only be sent through the raw request port.
 */

import { z } from 'zod'
import { isTuiAgent } from '../tui-agent-config'
import type { TuiAgent } from '../tui-agent'
import { WorktreeCreate } from './worktree-create-params'

const LaunchAgent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!isTuiAgent(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown TUI agent' })
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the superRefine above rejects anything isTuiAgent refuses, so the transform only ever runs on a TuiAgent.
  .transform((value): TuiAgent => value as TuiAgent)

export const AgentLaunch = z.object({
  agent: LaunchAgent,
  target: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('existing'),
      /** Any selector the runtime resolves, the same as every other worktree-addressed method. */
      worktree: z.string().min(1, 'Missing worktree selector')
    }),
    z.object({
      kind: z.literal('create-worktree'),
      /** The `worktree.create` request verbatim, so a caller migrating to this method keeps its
       *  existing payload; the agent fields in it are stripped rather than honoured. */
      create: WorktreeCreate
    })
  ]),
  prompt: z
    .object({
      text: z.string(),
      delivery: z.enum(['submit', 'draft'])
    })
    .optional(),
  /** Only the seedable string options a structured create accepts; a terminal launch ignores them. */
  sessionOptions: z.record(z.string(), z.string()).optional(),
  reuseTerminal: z.object({ handle: z.string().min(1, 'Missing terminal handle') }).optional()
})

export type AgentLaunchParams = z.infer<typeof AgentLaunch>
