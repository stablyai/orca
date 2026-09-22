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
import { parseAgentSessionOperationTimestamp } from '../agent-session-host-authority'
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
  /**
   * Names this launch so a retry replays instead of starting a second agent.
   *
   * Optional, and optional forever: shipped mobile sends none, and a host that required one would
   * refuse every live client. Its absence is not a silent downgrade to a weaker guarantee — it is
   * the caller declining the guarantee, and the host must never mint an id on a caller's behalf
   * after an ambiguous launch, because an id minted on the retry is a brand new operation.
   */
  operationId: z
    .string()
    .refine(
      (value) => parseAgentSessionOperationTimestamp(value) !== null,
      'Malformed launch operation id'
    )
    .optional(),
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
  reuseTerminal: z.object({ handle: z.string().min(1, 'Missing terminal handle') }).optional(),
  /** Nullable on purpose: `null` is "no arguments", absent is "use the settings default". */
  agentArgs: z.string().nullable().optional(),
  /** A start directory other than the workspace root. Terminal-only, and the host downgrades a
   *  structured launch that carries one rather than ignoring it. */
  cwd: z.string().min(1, 'Empty launch cwd').optional(),
  /**
   * Telemetry attribution, deliberately `z.string()` rather than the closed `launchSourceSchema`.
   *
   * Params are validated by the HOST, so a closed enum here is a version claim pointing the wrong
   * way: a newer client naming a launch surface an older host has never heard of would have its
   * whole launch refused over a label nothing reads as behaviour. Bookkeeping must not gate a user
   * action, so the arm set stays open here and the host parses it leniently at the point it is
   * actually used — the same `safeParse`-and-skip the PTY spawn already does.
   */
  launchSource: z.string().optional()
})

export type AgentLaunchParams = z.infer<typeof AgentLaunch>

// A distinct method prevents an older receiver from silently dropping the replay requirement.
export const AgentLaunchReplay = AgentLaunch.required({ operationId: true })
