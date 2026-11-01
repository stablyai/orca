/** Lost replies are retried, including mobile workspace creation: claim an operation ID durably before side effects, then replay its recorded answer. Unknown outcomes stay refused; this ledger neither adopts nor recovers orphaned surfaces. */

import { canonicalAgentSessionDigest } from './agent-session-mutation-envelope'
export { deriveAgentLaunchChildOperationId } from './agent-launch-child-operation'

/** Digest launch behavior, excluding its operation ID and mutable host settings; changed defaults must not conflict with an honest retry. */
export type AgentLaunchFingerprintInput = {
  agent: string
  createIdentity?: { instanceId: string }
  target:
    | { kind: 'existing'; worktree: string }
    | { kind: 'create-worktree'; create: Readonly<Record<string, unknown>> }
    | { kind: 'create-folder-workspace'; create: Readonly<Record<string, unknown>> }
  prompt?: { text: string; delivery: string }
  sessionOptions?: Readonly<Record<string, string>>
  chatOptions?: Readonly<Record<string, string>>
  reuseTerminal?: { handle: string }
  /** Arguments change operation identity; null explicitly clears defaults and differs from absence. */
  agentArgs?: string | null
  /** cwd changes both execution location and structured-to-terminal routing. */
  cwd?: string
  /** Pane identity enters the PTY env; another reservation must not replay an unreachable pane. */
  paneKey?: string
  /** Another caller-minted session names a different launch. */
  sessionId?: string
  /** In: unlike the user's default surface, an explicit pick is what the call asks to run. */
  surface?: string
  /** Exclude launchSource, placement and presentation: they change attribution/view, not execution. Replays truthfully retain the first launch's attribution. */
}

/** Compute on the host; trusting a caller digest permits false matches. */
export function computeAgentLaunchFingerprint(input: AgentLaunchFingerprintInput): string {
  return canonicalAgentSessionDigest({
    method: 'agent.launch',
    agent: input.agent,
    createIdentity: input.createIdentity,
    target: input.target,
    prompt: input.prompt,
    sessionOptions: input.sessionOptions,
    chatOptions: input.chatOptions,
    reuseTerminal: input.reuseTerminal,
    agentArgs: input.agentArgs,
    cwd: input.cwd,
    // Absent keys are dropped by the canonical form, so every digest without one is unchanged.
    paneKey: input.paneKey,
    sessionId: input.sessionId,
    surface: input.surface
  })
}
