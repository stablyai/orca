/** A launch the host accepts before its workspace's required Setup finishes, and the read that follows it.
 * Gated on agent.launch.accept.v1; older hosts lack both methods, so callers keep their shipped route. */

import { z } from 'zod'
import { sleepingAgentLaunchConfigSchema } from '../workspace-session-sleeping-agents'
import { parseAgentSessionOperationTimestamp } from '../agent-session/agent-session-host-authority'
import type { AgentLaunchResult } from '../agent-launch-intent'
import { AgentLaunchFields, refuseSessionIdForAnotherAgent } from './agent-launch-params'
import { Identifier } from './structured-agent-session-identifiers'

/** The longest one status read holds its reply open waiting for the launch to settle. */
export const AGENT_LAUNCH_STATUS_MAX_WAIT_MS = 20_000

/** How the launch's held message reaches a terminal alternative, decided by the caller's own planner:
 * `carried` rides the command already, so the host hands nothing again; `draft` is left unsent in
 * the agent's input; `none` delivers nothing. */
const TerminalPromptDisposition = z.enum(['submit', 'draft', 'none'])

/** The terminal a refused chat becomes, as the caller would have started it itself. Absent means it
 * would start none, so a refused chat ends the launch with nothing started. */
export const AgentLaunchTerminalStartup = z.discriminatedUnion('kind', [
  /** The host's own launcher for the agent, as a paired workspace seeds one with no plan of its own. */
  z.object({ kind: z.literal('agent'), prompt: TerminalPromptDisposition }),
  /** The caller planner's final command, run verbatim. */
  z.object({
    kind: z.literal('command'),
    command: z.string().min(1, 'Missing startup command'),
    env: z.record(z.string(), z.string()).optional(),
    launchConfig: sleepingAgentLaunchConfigSchema,
    startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
    prompt: z.enum(['carried', 'submit', 'draft', 'none'])
  })
])

export type AgentLaunchTerminalStartupParams = z.infer<typeof AgentLaunchTerminalStartup>

/** What a workspace creation that promised a chat reported about the Setup that chat waits for,
 * decided from the applied setup policy before its runner could fail. `runId` names that exact run,
 * which lives only in the creating host's memory; null when the caller holds no such name. */
export const AgentLaunchSetupReceipt = z.discriminatedUnion('required', [
  z.object({ required: z.literal(false) }),
  z.object({
    required: z.literal(true),
    runId: Identifier('Invalid setup run id').nullable()
  })
])

export type AgentLaunchSetupReceipt = z.infer<typeof AgentLaunchSetupReceipt>

/** agent.launchReplay's request for a workspace that already exists; a reused terminal has no Setup to wait for. */
export const AgentLaunchAccept = AgentLaunchFields.omit({ reuseTerminal: true })
  .extend({
    target: z.object({
      kind: z.literal('existing'),
      worktree: z.string().min(1, 'Missing worktree selector')
    }),
    /** The held message, under the id its chat founds it with, so every reader names one message. */
    prompt: z
      .object({
        text: z.string(),
        delivery: z.enum(['submit', 'draft']),
        clientMessageId: Identifier('Invalid client message id')
      })
      .optional(),
    terminalStartup: AgentLaunchTerminalStartup.optional(),
    /** Required: a missing receipt is uncertainty, never proof that nothing must be waited for. */
    setupReceipt: AgentLaunchSetupReceipt
  })
  .required({ operationId: true })
  .superRefine(refuseSessionIdForAnotherAgent)

export type AgentLaunchAcceptParams = z.infer<typeof AgentLaunchAccept>

export const AgentLaunchStatus = z.object({
  operationId: z
    .string()
    .refine(
      (value) => parseAgentSessionOperationTimestamp(value) !== null,
      'Malformed launch operation id'
    ),
  /** Hold the reply until the launch settles, at most this long; absent answers at once. */
  waitMs: z.number().int().min(0).max(AGENT_LAUNCH_STATUS_MAX_WAIT_MS).optional()
})

/** `unknown`: the launch was accepted but no execution survives to finish it, so it is never run again. */
export type AgentLaunchStatusResult =
  | { state: 'running' }
  | { state: 'succeeded'; result: AgentLaunchResult }
  | { state: 'failed'; code: string; message?: string }
  | { state: 'unknown' }
  | { state: 'absent' }

export type AgentLaunchAcceptResult = { operationId: string } & Exclude<
  AgentLaunchStatusResult,
  { state: 'absent' }
>
