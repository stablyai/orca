/**
 * Replay safety for `agent.launch`.
 *
 * A launch creates a workspace, an agent, or both. When its reply is lost, the caller cannot tell
 * "the host never saw it" from "the host ran it and the answer went missing" — and mobile retries a
 * lost create by design (`worktree-create-retry.ts`), so the retry is the ordinary case, not the
 * edge. Retrying without an operation id is how one tap becomes two agents in two workspaces.
 *
 * The fix is the ledger `agentSession.*` already runs on: the caller names the operation once, the
 * host records that name durably before doing anything, and every later arrival of that name gets
 * the recorded answer rather than a second agent. What this module adds is the launch-shaped parts
 * of that contract — the digest over what a launch DOES, and the child id its inner attach reserves
 * under.
 *
 * This is safety, not recovery. Nothing here probes for a surface a previous attempt may have left
 * behind, adopts one, or finishes an interrupted publication; an operation whose outcome is unknown
 * stays unknown and is refused.
 */

import { canonicalAgentSessionDigest } from './agent-session-mutation-envelope'
import { parseAgentSessionOperationTimestamp } from './agent-session-host-authority'

/**
 * The launch fields that decide what the call does. The operation id itself is excluded — it names
 * the operation, it is not part of it — and so is every mutable host setting: the route a launch
 * takes depends on the user's default surface, and folding that in would make an honest retry
 * conflict merely because the setting moved between the two attempts.
 */
export type AgentLaunchFingerprintInput = {
  agent: string
  target:
    | { kind: 'existing'; worktree: string }
    | { kind: 'create-worktree'; create: Readonly<Record<string, unknown>> }
  prompt?: { text: string; delivery: string }
  sessionOptions?: Readonly<Record<string, string>>
  reuseTerminal?: { handle: string }
  /** In: a launch carrying `--model opus` is a different operation from one without, so a retry
   *  that changed them must conflict rather than replay the first answer. `null` is a value here,
   *  not an absence — "explicitly no arguments" differs from "use the settings default". */
  agentArgs?: string | null
  /** In: it decides both where the agent runs and, through `tui_launch_command`, which surface it
   *  gets. Two launches differing only in `cwd` are genuinely two operations. */
  cwd?: string
  /**
   * `launchSource` is deliberately absent, and this is the reasoned exclusion rather than an
   * oversight: it is telemetry, so two launches differing only in which button produced them do the
   * same thing, and folding it in would make an honest retry that got re-attributed conflict with
   * its own original. That is the rule the mutable host settings above are excluded under — the
   * digest covers what the call DOES — and the cost of leaving it out is only that a replay reports
   * the first attempt's attribution, which is the truthful answer: one launch happened.
   */
}

/** Host-computed, never accepted from the caller: a digest a client supplies is a digest a buggy
 *  client can make agree with anything. */
export function computeAgentLaunchFingerprint(input: AgentLaunchFingerprintInput): string {
  return canonicalAgentSessionDigest({
    method: 'agent.launch',
    agent: input.agent,
    target: input.target,
    prompt: input.prompt,
    sessionOptions: input.sessionOptions,
    reuseTerminal: input.reuseTerminal,
    agentArgs: input.agentArgs,
    cwd: input.cwd
  })
}

const OPERATION_ID_ENTROPY_LENGTH = 32

/**
 * The id the launch's inner `agentSession.attach` reserves under.
 *
 * The ledger keys a row on `(callerKey, operationId)` with no method in it, and a structured launch
 * reserves in that same ledger under the same caller. Forwarding the launch's own id would make the
 * attach meet the launch's row, disagree with its fingerprint, and refuse a conflict before
 * anything was created. Derived rather than random so the child of a given launch is always the
 * same id — a launch is claimed once, and a claim that could name a different child each time would
 * be ownership in name only.
 *
 * The launch's timestamp is kept so the child ages out on the same schedule as its parent.
 */
export function deriveAgentLaunchChildOperationId(operationId: string): string | null {
  const timestamp = parseAgentSessionOperationTimestamp(operationId)
  if (timestamp === null) {
    return null
  }
  const entropy = canonicalAgentSessionDigest({
    child: 'agent.launch:attach',
    operationId
  }).slice(0, OPERATION_ID_ENTROPY_LENGTH)
  return `${timestamp}-${entropy}`
}
