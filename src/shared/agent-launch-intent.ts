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

export type AgentLaunchIntent = {
  agent: TuiAgent
  target: AgentLaunchTarget
  prompt?: AgentLaunchPrompt
  /** Seeded launch options: narrowed to what a structured create accepts, and read as the model,
   *  effort and mode preferences of a terminal launch. */
  sessionOptions?: Readonly<Record<string, unknown>>
  reuseTerminal?: AgentLaunchReusedTerminal
  /**
   * Per-call replacement for the user's configured launch arguments, as a saved launch recipe
   * carries. Tri-state and must stay so: absent means "use the settings default", `null` means the
   * caller explicitly wants none, and collapsing the two would make a recipe that clears its args
   * silently inherit whatever the settings happen to hold.
   *
   * Deliberately NOT a route input. `hasExplicitTuiLaunchCommand` reads the launch *command* and
   * pointedly not the arguments, because structured chat drives Claude through the Agent SDK and
   * Codex through app-server, whose option sets are versioned independently of the interactive
   * CLI's. So args reaching a structured launch are ignored rather than forcing a terminal — the
   * host says so in `warning` instead of quietly honouring neither the args nor the preference.
   */
  agentArgs?: string | null
  /**
   * Where the agent starts, when that is not the workspace root — a resumed session's recorded
   * subdirectory is the case that needs it.
   *
   * Unlike `agentArgs` this one DOES decide the route: only a terminal can be started somewhere
   * other than its workspace, so a launch carrying one downgrades with `tui_launch_command` rather
   * than running a structured session in the wrong directory.
   */
  cwd?: string
  /**
   * Which surface the user acted on, for the `agent_started` telemetry triple. Never read as
   * behaviour — the host derives the other two members of that triple and this one is the only part
   * it cannot know.
   */
  launchSource?: string
  /** The `tabId:leafId` a terminal launch creates its pane under, for a caller that places its own
   *  tabs. Not a route input; refused when that pane is already live. */
  paneKey?: string
  /** The caller-minted id of the chat session a structured launch creates. Not a route input;
   *  refused when that session already exists. */
  sessionId?: string
}

/** The surface the host actually created. */
export type AgentLaunchOutcome =
  | { kind: 'structured'; sessionId: string; handle: string }
  | {
      kind: 'terminal'
      handle: string
      /**
       * The pane the host minted for this agent, as `tabId:leafId` — read it with `parsePaneKey`.
       *
       * Identity, not placement. The host already mints this pair, bakes it into the PTY's
       * environment and hands it to its own reveal; a client that draws its own tabs previously had
       * no way to learn it, because a `term_*` handle is a main-side mapping the renderer cannot
       * resolve. Where that pane goes — which group, what order, whether it takes focus — stays
       * with the client and never rides this wire.
       *
       * One field rather than a `tabId`/`leafId` pair, because the key already carries both and two
       * copies of one fact can disagree.
       *
       * Absent when this launch minted no pane, such as a reused terminal that was already running,
       * or when the runtime could not report the pane it created.
       */
      paneKey?: string
    }
/**
 * What became of the launch text.
 *
 * An enum rather than a boolean because "not delivered" and "handed to a surface that delivers it
 * out of band" are different answers, and a caller deciding whether to resend needs to tell them
 * apart. A receipt may under-claim — reporting a delivery it cannot vouch for as `not-delivered` is
 * a wasted resend, while over-claiming loses the text silently.
 */
export type AgentLaunchPromptOutcome = AgentLaunchPromptDisposal['outcome']

/** `messageId` hangs off the `journaled` arm rather than sitting optional beside all three: a
 *  producer must not be able to claim the text was committed and then not say where. */
export type AgentLaunchPromptDisposal =
  /** Committed to the session's transcript, which `messageId` names. */
  | { outcome: 'journaled'; messageId: string }
  /**
   * Handed to a terminal agent, either on the launch command that started it or as a bracketed
   * paste into its live PTY. No `messageId`, because a terminal keeps no transcript to name a row
   * in: what the agent does with the text is observable only in the pane. The caller must NOT
   * resend — a second paste arrives as a second turn, which is worse than the wasted resend
   * `not-delivered` costs.
   */
  | { outcome: 'handed-to-terminal' }
  /** Not delivered by this call; the caller still owns the text. */
  | { outcome: 'not-delivered' }

export type AgentLaunchPromptReceipt = {
  delivery: AgentLaunchPromptDelivery
} & AgentLaunchPromptDisposal

export type AgentLaunchResult = {
  outcome: AgentLaunchOutcome
  /** The workspace the agent runs in, resolved or created. */
  worktreeId: string
  /**
   * The launch completed but something in it did not: a startup terminal that failed to spawn,
   * untracked files that could not be copied. `worktree.create` returns this at the top level and
   * mobile already surfaces it, so a launch that drops it lands the user on a workspace that is
   * quietly incomplete.
   *
   * Top level rather than on the outcome, and deliberately the ONLY place a launch warning lives:
   * it is produced by the create as often as by the surface, it applies to a structured session
   * and a terminal alike, and a reader should not have to branch on `outcome.kind` to discover
   * that the workspace it just opened is missing something.
   */
  warning?: string
  /** Why the outcome is what it is — always populated, so a downgrade is never silent. */
  receipt: AgentLaunchModeReceipt
  prompt?: AgentLaunchPromptReceipt
}

export type AgentLaunchMode = 'structured' | 'terminal'

/** Why a launch ran in the mode it did. `user_default` is the preference being honoured; every
 *  other member is a reason the preference could not be applied to this launch. */
export type AgentLaunchModeReason =
  | 'user_default'
  | 'remote_execution_host'
  | 'reused_terminal'
  | 'agent_without_structured_session'
  | 'tui_launch_command'
  | 'structured_sessions_unavailable'
  | 'structured_support_unknown'
  | 'wsl_execution_runtime'
  | 'codex_on_windows'
  | 'structured_unsupported_on_host'

/** Restates `WorkerStartModeReceipt` in surface-neutral terms so orchestration's receipt and a
 *  mobile or renderer launch report the same vocabulary. */
export type AgentLaunchModeReceipt = {
  /** The mode the launch actually ran in. */
  mode: AgentLaunchMode
  /** The user's settings default for a new agent tab. */
  preferred: AgentLaunchMode
  reason: AgentLaunchModeReason
  /** One sentence, always present, so a fallback is never silent. */
  detail: string
}

/**
 * Narrows a launch result read back from durable storage.
 *
 * Lives beside the type rather than in the store so the two cannot drift: a field added above and
 * not checked here is a field a replay can hand back unvalidated. Every optional field is checked
 * when present and ignored when absent, so a row written by an older host still reads.
 */
export function isAgentLaunchResult(value: unknown): value is AgentLaunchResult {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowing an unknown for field-by-field validation; every field read below is checked before use.
  const result = value as Partial<AgentLaunchResult>
  return (
    isAgentLaunchOutcome(result.outcome) &&
    typeof result.worktreeId === 'string' &&
    isAgentLaunchModeReceipt(result.receipt) &&
    (result.warning === undefined || typeof result.warning === 'string') &&
    (result.prompt === undefined || isAgentLaunchPromptReceipt(result.prompt))
  )
}

function isAgentLaunchPromptReceipt(value: unknown): value is AgentLaunchPromptReceipt {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('delivery' in value) || !isAgentLaunchPromptDelivery(value.delivery)) {
    return false
  }
  if (!('outcome' in value)) {
    return false
  }
  return value.outcome === 'journaled'
    ? 'messageId' in value && typeof value.messageId === 'string'
    : value.outcome === 'handed-to-terminal' || value.outcome === 'not-delivered'
}

function isAgentLaunchOutcome(value: unknown): value is AgentLaunchOutcome {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the assertion claims only that the keys may be present and unknown, which is true of any object.
  const outcome = value as {
    kind?: unknown
    handle?: unknown
    sessionId?: unknown
    paneKey?: unknown
  }
  if (typeof outcome.handle !== 'string' || outcome.handle.length === 0) {
    return false
  }
  return outcome.kind === 'terminal'
    ? // Checked when present, ignored when absent: a row written before this field existed, or by a
      // runtime that minted no pane, still reads. Deliberately not parsed — a read-side shape rule
      // stricter than the write side turns one odd row into a refused replay.
      outcome.paneKey === undefined || typeof outcome.paneKey === 'string'
    : outcome.kind === 'structured' &&
        typeof outcome.sessionId === 'string' &&
        outcome.sessionId.length > 0
}

function isAgentLaunchModeReceipt(value: unknown): value is AgentLaunchModeReceipt {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowing an unknown for field-by-field validation; every field read below is checked before use.
  const receipt = value as Partial<AgentLaunchModeReceipt>
  return (
    (receipt.mode === 'structured' || receipt.mode === 'terminal') &&
    (receipt.preferred === 'structured' || receipt.preferred === 'terminal') &&
    typeof receipt.reason === 'string' &&
    typeof receipt.detail === 'string'
  )
}

function isAgentLaunchPromptDelivery(value: unknown): value is AgentLaunchPromptDelivery {
  return value === 'submit' || value === 'draft'
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
export function withoutReservedAgentCreateFields<Create extends Readonly<Record<string, unknown>>>(
  create: Create
): Create {
  const stripped: Record<string, unknown> = { ...create }
  for (const field of AGENT_LAUNCH_RESERVED_CREATE_FIELDS) {
    delete stripped[field]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every reserved field is optional on a create payload, so dropping them leaves the caller's own shape.
  return stripped as Create
}
