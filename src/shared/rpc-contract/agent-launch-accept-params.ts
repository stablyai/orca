/** A launch the host accepts before its workspace's required Setup finishes, and the read that follows it.
 * Gated on agent.launch.accept.v1; older hosts lack both methods, so callers keep their shipped route. */

import { z } from 'zod'
import { sleepingAgentLaunchConfigSchema } from '../workspace-session-sleeping-agents'
import { parseAgentSessionOperationTimestamp } from '../agent-session/agent-session-host-authority'
import type { AgentLaunchResult } from '../agent-launch-intent'
import { AgentLaunchFields, refuseSessionIdForAnotherAgent } from './agent-launch-params'

/** The longest one status read holds its reply open waiting for the launch to settle. */
export const AGENT_LAUNCH_STATUS_MAX_WAIT_MS = 20_000

/** The caller's own terminal startup, the shape worktree.create accepts for a desktop-built command:
 * a terminal alternative runs it verbatim instead of a host-rebuilt launcher. */
export const AgentLaunchTerminalStartup = z.object({
  command: z.string().min(1, 'Missing startup command'),
  env: z.record(z.string(), z.string()).optional(),
  launchConfig: sleepingAgentLaunchConfigSchema,
  startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
  /** How the launch prompt reaches this terminal: sent, or left unsent in the agent's input. */
  promptDelivery: z.enum(['submit', 'draft'])
})

export type AgentLaunchTerminalStartupParams = z.infer<typeof AgentLaunchTerminalStartup>

/** agent.launchReplay's request for a workspace that already exists; a reused terminal has no Setup to wait for. */
export const AgentLaunchAccept = AgentLaunchFields.omit({ reuseTerminal: true })
  .extend({
    target: z.object({
      kind: z.literal('existing'),
      worktree: z.string().min(1, 'Missing worktree selector')
    }),
    terminalStartup: AgentLaunchTerminalStartup.optional()
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
