/** Shared agent.launch schema lets remote clients use typed RpcSendParams.
 * The host honors an explicit surface or refuses it; migrated worktree.create startup-agent fields are stripped. */

import { AGENT_LAUNCH_SURFACES } from '../agent-launch-surface'
import { z } from 'zod'
import { isAgentSessionOptions } from '../agent-session-record'
import { parseAgentSessionOperationTimestamp } from '../agent-session-host-authority'
import { parsePaneKey } from '../stable-pane-id'
import { isValidHostTerminalTabId } from '../terminal-tab-id'
import { isTuiAgent } from '../tui-agent-config'
import type { TuiAgent } from '../tui-agent'
import { WorktreeCreate } from './worktree-create-params'
import { FolderWorkspaceCreate } from './folder-workspace-params'
import { LaunchSourceParam } from './launch-source-param'
import { TerminalTabIdParam } from './agent-session-params'
import { SessionId } from './structured-agent-session-params'
import { isStructuredAgentSessionIdFor } from '../structured-agent-session-create'
import { AgentLaunchAccountEnv } from '../agent-launch-account-env'

const LaunchAgent = z.custom<TuiAgent>(isTuiAgent, { message: 'Unknown TUI agent' })

/** A layout id the caller may get wrong without failing the launch: anything but a string is dropped. */
const tolerantTabLayoutId = z
  .unknown()
  .transform((value): string | undefined => (typeof value === 'string' ? value : undefined))
  .optional()

export const AgentLaunchFields = z.object({
  agent: LaunchAgent,
  /** Caller-minted retry identity; optional forever for shipped clients. Never mint after an ambiguous launch:
   * a fresh ID on retry would create another operation instead of replaying. */
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
      /** Preserve the worktree.create payload while stripping its migrated agent fields. */
      create: WorktreeCreate
    }),
    z.object({
      kind: z.literal('create-folder-workspace'),
      /** The `folderWorkspace.create` request verbatim; its `createdWithAgent` is the launch's own. */
      create: FolderWorkspaceCreate
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
  /** A saved launch choice; absent `sessionOptions`, a terminal applies it as flags too. */
  chatOptions: z.record(z.string(), z.string()).refine(isAgentSessionOptions).optional(),
  reuseTerminal: z.object({ handle: z.string().min(1, 'Missing terminal handle') }).optional(),
  /** Nullable on purpose: `null` is "no arguments", absent is "use the settings default". */
  agentArgs: z.string().nullable().optional(),
  /** Terminal-only cwd; structured launches downgrade rather than silently ignoring it. */
  cwd: z.string().min(1, 'Empty launch cwd').optional(),
  launchSource: LaunchSourceParam.optional(),
  /** Caller reserves identity, not placement; validate verbatim adoption so reservations match.
   * Structured launches use its tab half as tabId; reused terminals ignore it. paneKey reports the actual pane.
   * Tab IDs span workspaces, so mint a fresh UUID per launch. */
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
  /** Caller-reserved chat ID; refuse duplicates, ignore for terminal outcomes. The returned sessionId is authoritative. */
  sessionId: SessionId.optional(),
  /** View-only placement is outside replay identity and never fails launch: fall back from missing group to
   * anchor group, then active group; drop unknown keys. Requires agent.launch.placement.v1; receipt reports placement. */
  placement: z
    .object({ groupId: tolerantTabLayoutId, afterTabId: tolerantTabLayoutId })
    .optional()
    .catch(undefined),
  /** focused selects the tab; background leaves selection; absent reveals as before. Caller navigation defaults
   * keep paired-device selection local. View-only, outside replay identity; unknown words read as absent. */
  presentation: z
    .unknown()
    .transform((value): 'focused' | 'background' | undefined =>
      value === 'focused' || value === 'background' ? value : undefined
    )
    .optional(),
  /** Desktop-prepared Claude/Codex home for WSL orcad without account services. Terminal-only; chat warns and
   * keeps its host home. Optional forever, outside replay identity; old hosts strip it and use their default. */
  accountEnv: AgentLaunchAccountEnv.optional(),
  /** Forward the launching user’s chat default when host settings belong to someone else (e.g. relayed phone).
   * Explicit surface overrides it; feasibility still decides. Outside replay identity; old hosts use their own default. */
  nativeChatDefault: z.boolean().optional(),
  /** Explicit terminal runs CLI; proven-unsupported chat refuses before creation. Inside replay identity; unknown
   * values refuse. Clients must gate on agent.launch.surface.v1 because older hosts strip this field. */
  surface: z.enum(AGENT_LAUNCH_SURFACES).optional()
})

/** Caller IDs must retain the agent lane encoded by host-minted IDs. */
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
