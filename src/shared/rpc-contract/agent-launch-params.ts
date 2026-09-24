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
import { parsePaneKey } from '../stable-pane-id'
import { isValidHostTerminalTabId } from '../terminal-tab-id'
import { isTuiAgent } from '../tui-agent-config'
import type { TuiAgent } from '../tui-agent'
import { WorktreeCreate } from './worktree-create-params'
import { TerminalTabIdParam } from './agent-session-params'
import { SessionId } from './structured-agent-session-params'
import { isStructuredAgentSessionIdFor } from '../structured-agent-session-create'

const LaunchAgent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!isTuiAgent(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown TUI agent' })
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the superRefine above rejects anything isTuiAgent refuses, so the transform only ever runs on a TuiAgent.
  .transform((value): TuiAgent => value as TuiAgent)

/** The launch's fields without the cross-field check, for building an older host's shape in tests;
 *  every receiver parses `AgentLaunch` or `AgentLaunchReplay`. */
export const AgentLaunchFields = z.object({
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
  /** A chat seeds the options it accepts; a terminal launch reads the model, effort and mode. */
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
  launchSource: z.string().optional(),
  /**
   * The pane a terminal launch should create, minted by a caller that places its own tabs.
   *
   * Identity, never placement: the host still reveals the tab, and the caller finds its placement
   * by this key. Refused here unless the runtime would adopt it verbatim (it trims, and mints its
   * own for an invalid one), so the caller's reservation always matches. Ignored by a structured
   * launch and a reused terminal, which create no pane; the outcome's `paneKey` says which pane
   * really exists. Tab ids are global across workspaces, so the caller mints a fresh UUID for each.
   */
  paneKey: z
    .string()
    .refine((value) => {
      const pane = parsePaneKey(value)
      return (
        pane !== null &&
        pane.tabId === pane.tabId.trim() &&
        TerminalTabIdParam.safeParse(pane.tabId).success &&
        isValidHostTerminalTabId(pane.tabId)
      )
    }, 'Malformed launch pane key')
    .optional(),
  /**
   * The id of the chat session a structured launch creates, minted by the caller so it knows which
   * conversation it started before the reply arrives. Refused when a session with this id already
   * exists. Ignored when the launch settles as a terminal; the outcome's `sessionId` says which
   * session really exists.
   */
  sessionId: SessionId.optional()
})

/** A caller-minted session id must be shaped like every id the host mints, so an id still names
 *  its lane on sight. */
function refuseSessionIdForAnotherAgent(
  launch: { agent: string; sessionId?: string | undefined },
  ctx: z.RefinementCtx
): void {
  if (launch.sessionId && !isStructuredAgentSessionIdFor(launch.agent, launch.sessionId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionId'],
      message: 'Launch session id must be named for its agent'
    })
  }
}

export const AgentLaunch = AgentLaunchFields.superRefine(refuseSessionIdForAnotherAgent)

export type AgentLaunchParams = z.infer<typeof AgentLaunch>

// A distinct method prevents an older receiver from silently dropping the replay requirement.
export const AgentLaunchReplay = AgentLaunchFields.required({ operationId: true }).superRefine(
  refuseSessionIdForAnotherAgent
)
