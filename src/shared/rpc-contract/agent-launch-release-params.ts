/** A launch prepared before its workspace's required Setup finishes and released with the first turn's
 * final choices. Gated on agent.launch.release.v1: prepare claims the launch exactly as accept does but
 * runs nothing until release hands it one immutable input, so a pick made while Setup ran governs the
 * first turn on either surface. Older hosts lack both methods, so callers keep their chosen route. */

import { z } from 'zod'
import { isAgentSessionOptions } from '../agent-session/lifecycle/agent-session-record'
import { parseAgentSessionOperationTimestamp } from '../agent-session/agent-session-host-authority'
import { AgentSessionSelectionSchema } from '../agent-session/options/agent-session-execution-options'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import type { AgentStartupPlanInputs } from '../agent-launch/startup/agent-startup-plan-inputs'
import { AgentLaunchFields, refuseSessionIdForAnotherAgent } from './agent-launch-params'
import {
  AgentLaunchHeldPrompt,
  AgentLaunchSetupReceipt,
  type AgentLaunchStatusResult
} from './agent-launch-accept-params'

const NODE_PLATFORMS = [
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32'
] as const satisfies readonly NodeJS.Platform[]

const TuiAgentParam = z.custom<TuiAgent>(isTuiAgent, { message: 'Unknown TUI agent' })

/** The ordinary planner's own inputs, resolved by the caller when it planned this terminal, so the host
 *  recompiles that plan with the released choices rather than rereading anyone's settings. */
export const AgentStartupPlanInputsParam = z.object({
  agent: TuiAgentParam,
  cmdOverrides: z.record(z.string(), z.string()),
  agentArgs: z.string().nullable(),
  agentEnv: z.record(z.string(), z.string()),
  platform: z.enum(NODE_PLATFORMS),
  shell: z.enum(['posix', 'powershell', 'cmd']).optional(),
  isRemote: z.boolean(),
  sessionOptions: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  sessionOptionsOverrideAgentArgs: z.boolean(),
  suppressStartupUpdatePrompt: z.boolean().optional()
})

export type AgentStartupPlanInputsParams = z.infer<typeof AgentStartupPlanInputsParam>

/** The planner's typed inputs; a key the schema lacks fails to compile here rather than drift. */
export function agentStartupPlanInputsFromParams(
  base: AgentStartupPlanInputsParams
): AgentStartupPlanInputs {
  const cmdOverrides: Partial<Record<TuiAgent, string>> = {}
  for (const [agent, command] of Object.entries(base.cmdOverrides)) {
    if (isTuiAgent(agent)) {
      cmdOverrides[agent] = command
    }
  }
  return {
    agent: base.agent,
    cmdOverrides,
    agentArgs: base.agentArgs,
    agentEnv: base.agentEnv,
    platform: base.platform,
    shell: base.shell,
    isRemote: base.isRemote,
    sessionOptionsOverrideAgentArgs: base.sessionOptionsOverrideAgentArgs,
    ...(base.sessionOptions ? { sessionOptions: base.sessionOptions } : {}),
    ...(base.suppressStartupUpdatePrompt !== undefined
      ? { suppressStartupUpdatePrompt: base.suppressStartupUpdatePrompt }
      : {})
  }
}

/** How the caller's planner would have delivered the held message, and from which inputs. */
export const AgentLaunchTerminalPolicy = z.discriminatedUnion('kind', [
  /** In view: a new agent tab planned with the parent's held message at the end. */
  z.object({
    kind: z.literal('foreground'),
    promptDelivery: z.enum(['auto-submit', 'draft', 'submit-after-ready']),
    isFollowupPath: z.boolean()
  }),
  /** Out of view: the creation's quick plan, from its own prompt and draft. */
  z.object({
    kind: z.literal('background'),
    prompt: z.string(),
    draftPrompt: z.string().min(1).optional(),
    heldChatMessage: z.boolean(),
    paired: z.boolean()
  })
])

export type AgentLaunchTerminalPolicyParams = z.infer<typeof AgentLaunchTerminalPolicy>

const TerminalPromptDisposition = z.enum(['submit', 'draft', 'none'])

/** The terminal a refused chat becomes. `none`: no terminal; `agent`: the host's own launcher;
 *  `planned`: the caller's ordinary plan, compiled on the host only if the terminal is needed. */
export const AgentLaunchTerminalAlternative = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('agent'), prompt: TerminalPromptDisposition }),
  z.object({
    kind: z.literal('planned'),
    base: AgentStartupPlanInputsParam,
    policy: AgentLaunchTerminalPolicy
  })
])

export type AgentLaunchTerminalAlternativeParams = z.infer<typeof AgentLaunchTerminalAlternative>

/** accept's request without its final choices: those arrive with release, after Setup. */
export const AgentLaunchPrepare = AgentLaunchFields.omit({
  reuseTerminal: true,
  sessionOptions: true,
  chatOptions: true
})
  .extend({
    target: z.object({
      kind: z.literal('existing'),
      worktree: z.string().min(1, 'Missing worktree selector')
    }),
    prompt: AgentLaunchHeldPrompt.optional(),
    terminalAlternative: AgentLaunchTerminalAlternative,
    /** Required: a missing receipt is uncertainty, never proof that nothing must be waited for. */
    setupReceipt: AgentLaunchSetupReceipt
  })
  .required({ operationId: true })
  .superRefine(refuseSessionIdForAnotherAgent)

export type AgentLaunchPrepareParams = z.infer<typeof AgentLaunchPrepare>

/** The first turn's final choices for a prepared launch: the create options and the opening message's
 *  selection, as an ordinary send freezes them. Selection is required, even empty, so its absence can
 *  never bring back a remembered model or effort. */
export const AgentLaunchRelease = z.object({
  operationId: z
    .string()
    .refine(
      (value) => parseAgentSessionOperationTimestamp(value) !== null,
      'Malformed launch operation id'
    ),
  options: z.record(z.string(), z.string()).refine(isAgentSessionOptions),
  optionsMode: z.literal('replace-model-selection').optional(),
  selection: AgentSessionSelectionSchema
})

export type AgentLaunchReleaseParams = z.infer<typeof AgentLaunchRelease>

/** What the prepared launch runs with once released. */
export type AgentLaunchReleasedInput = Omit<AgentLaunchReleaseParams, 'operationId'>

/** The prepared launch's own status: `running` once this input is installed, or how it ended. */
export type AgentLaunchReleaseResult = { operationId: string } & AgentLaunchStatusResult
