/**
 * What a caller asks for when it wants an agent running somewhere, independent of which surface
 * asked and of whether the answer turns out to be a structured session or a terminal.
 *
 * Every launch surface builds one of these: the renderer's agent tabs and workspace creates,
 * mobile's create sheet and new-tab button, `orchestration.workerStart`, and the CLI. The host
 * resolves it once — settings default plus per-launch feasibility from
 * `structured-native-chat-launch-route` — so no surface carries its own copy of that decision.
 *
 * The intent deliberately does NOT name a mode. A caller states what it wants to happen, not how
 * to deliver it; picking structured vs terminal is the host's job and is reported back in the
 * receipt rather than requested here.
 */

import type { TuiAgent } from './tui-agent'

/** How a launch's initial text reaches the agent. */
export type AgentLaunchPromptDelivery =
  /** Sent as the agent's first turn once it is ready. */
  | 'submit'
  /** Left unsent for the user to edit and send. Historically this forced a terminal, because a
   *  draft lived in the TUI's input and chat only mirrored it; a structured session accepts one
   *  directly, so it no longer decides the route. */
  | 'draft'

export type AgentLaunchPrompt = {
  text: string
  delivery: AgentLaunchPromptDelivery
}

/**
 * Where the agent lands.
 *
 * `create-worktree` is part of the intent rather than a separate call the caller makes first,
 * because the route cannot be settled before the workspace exists: `agentSession.createSupport`
 * can only answer for a workspace the host can resolve. Splitting the two is exactly what made
 * every new-worktree launch a terminal — the worktree was created agent-first, so the structured
 * branch below it was unreachable.
 */
export type AgentLaunchTarget =
  /** A workspace that already exists, addressed by any selector the runtime resolves. */
  | { kind: 'existing'; worktree: string }
  /** A worktree this launch creates. `create` is the `worktree.create` request minus its agent
   *  fields — the launch owns those, so a caller cannot set a startup agent behind the router. */
  | { kind: 'create-worktree'; create: Readonly<Record<string, unknown>> }

/** An existing terminal the caller wants reused rather than a fresh surface. Always resolves to a
 *  terminal agent: a running PTY keeps its execution transport. */
export type AgentLaunchReusedTerminal = { handle: string }

/**
 * Facts that only the calling surface knows and that the route has to see. These are inputs to the
 * decision, not requests: a caller states that it is passing custom agent arguments, and the host
 * concludes that a terminal is required.
 */
export type AgentLaunchCustomization = {
  /** Explicit per-launch agent argv. Only a TUI applies these. */
  agentArgs?: string
  /** A subdirectory the agent should start in. Only a TUI applies this. */
  cwd?: string
}

export type AgentLaunchIntent = {
  agent: TuiAgent
  target: AgentLaunchTarget
  prompt?: AgentLaunchPrompt
  /** Seeded launch options, narrowed by the host to what a structured create accepts. */
  sessionOptions?: Readonly<Record<string, unknown>>
  reuseTerminal?: AgentLaunchReusedTerminal
  customization?: AgentLaunchCustomization
}

/** The surface the host actually created. */
export type AgentLaunchOutcome =
  | { kind: 'structured'; sessionId: string; handle: string }
  | { kind: 'terminal'; handle: string; warning?: string }

/** Whether the launch text was delivered, for a caller that needs to report or retry it. */
export type AgentLaunchPromptReceipt = {
  delivery: AgentLaunchPromptDelivery
  delivered: boolean
}

export type AgentLaunchResult = {
  outcome: AgentLaunchOutcome
  /** The workspace the agent runs in, resolved or created. */
  worktreeId: string
  /** Why the outcome is what it is — always populated, so a downgrade is never silent. */
  receipt: AgentLaunchModeReceipt
  prompt?: AgentLaunchPromptReceipt
}

/** Restates `WorkerStartModeReceipt` in surface-neutral terms so orchestration's receipt and a
 *  mobile or renderer launch report the same vocabulary. */
export type AgentLaunchModeReceipt = {
  mode: 'structured' | 'terminal'
  /** The user's settings default for a new agent tab. */
  preferred: 'structured' | 'terminal'
  reason: string
  /** One sentence, always present. */
  detail: string
}

export function agentLaunchTargetIsCreate(
  target: AgentLaunchTarget
): target is Extract<AgentLaunchTarget, { kind: 'create-worktree' }> {
  return target.kind === 'create-worktree'
}

/** The agent fields a create payload must not carry: the launch owns placement, and a caller that
 *  sets one of these would route itself around the host's decision. */
export const AGENT_LAUNCH_RESERVED_CREATE_FIELDS = [
  'startupAgent',
  'startupCommand',
  'startupPrompt',
  'startupDraft',
  'startupLaunchConfig',
  'startupEnv',
  'startupCommandDelivery'
] as const

/** Strips the reserved agent fields from a create payload. Callers migrating from
 *  `worktree.create` pass their existing params; this keeps a stale `startupAgent` from
 *  re-creating the agent-first path the router exists to replace. */
export function withoutReservedAgentCreateFields(
  create: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const stripped: Record<string, unknown> = { ...create }
  for (const field of AGENT_LAUNCH_RESERVED_CREATE_FIELDS) {
    delete stripped[field]
  }
  return stripped
}
