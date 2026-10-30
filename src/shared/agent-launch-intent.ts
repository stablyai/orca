/** One launch intent for desktop/mobile/CLI/orchestration; the host resolves settings and per-launch feasibility once and reports the created surface. */

import type { TuiAgent } from './tui-agent'
import type { AgentLaunchSurface } from './agent-launch-surface'

/** How a launch's initial text reaches the agent. */
export type AgentLaunchPromptDelivery =
  /** Sent as the agent's first turn once it is ready. */
  | 'submit'
  /** Unsent text for editing; structured sessions accept drafts directly, so this no longer forces a terminal. */
  | 'draft'

export type AgentLaunchPrompt = {
  text: string
  delivery: AgentLaunchPromptDelivery
}

/** Create the workspace inside launch: structured support cannot be resolved before it exists, and agent-first creation bypassed that route. */
export type AgentLaunchTarget =
  /** A workspace that already exists, addressed by any selector the runtime resolves. */
  | {
      kind: 'existing'
      worktree: string
      /** Host-resolved workspace root; never caller-set because it determines whether cwd is outside the root. */
      workspacePath?: string
      /** Host-resolved SSH connection; transcript accessibility decides which view opens. */
      connectionId?: string | null
    }
  /** Launch owns agent fields; create params cannot bypass its router with a startup agent. */
  | { kind: 'create-worktree'; create: Readonly<Record<string, unknown>> }
  /** A folder workspace this launch creates. `create` is the `folderWorkspace.create` request. */
  | { kind: 'create-folder-workspace'; create: Readonly<Record<string, unknown>> }

/** A reused PTY retains its execution transport and always resolves to a terminal agent. */
export type AgentLaunchReusedTerminal = { handle: string }

export type AgentLaunchIntent = {
  agent: TuiAgent
  target: AgentLaunchTarget
  prompt?: AgentLaunchPrompt
  /** Structured create options also supply terminal model/effort/mode preferences. */
  sessionOptions?: Readonly<Record<string, unknown>>
  chatOptions?: Readonly<Record<string, string>>
  reuseTerminal?: AgentLaunchReusedTerminal
  /** Tri-state arguments: absent uses defaults, null explicitly clears them. Overrides remain terminal-only; structured chat uses host settings and reports a warning. */
  agentArgs?: string | null
  /** An outside-workspace cwd forces a terminal via tui_launch_command; structured sessions cannot start in another directory. */
  cwd?: string
  /** Caller-only UI source for agent_started telemetry; never affects launch behavior. */
  launchSource?: string
  /** Caller-placed tab's pane identity; not a route input, and refused if already live. */
  paneKey?: string
  /** Caller-minted chat identity; not a route input, and refused if already present. */
  sessionId?: string
  /** Account routing env for a terminal agent (`agent.launch`'s `accountEnv`). Not a route input. */
  accountEnv?: Readonly<Record<string, string>>
  /** `agent.launch`'s `nativeChatDefault`: the caller's chat default in place of the host's own. */
  nativeChatDefault?: boolean
  /** `agent.launch`'s `surface`: the user's pick for this launch, ahead of either default. */
  surface?: AgentLaunchSurface
}

/** Placement cannot fail a launch: missing groups fall back to the anchor's group, then the active group. */
export type AgentLaunchPlacement = { groupId?: string; afterTabId?: string }

/** Whether the caller's own view moves to the new tab. Never names another viewer's screen. */
export type AgentLaunchPresentation = 'focused' | 'background'

/** Where the tab landed, as the window that owns the layout reported it. */
export type AgentLaunchPlacementReceipt = {
  groupId: string
  /** Present when the requested group was not used: the anchor tab's group, or the active one. */
  fallback?: 'anchor-group' | 'active-group'
}

/** The surface the host actually created. */
export type AgentLaunchOutcome =
  | {
      kind: 'structured'
      sessionId: string
      handle: string
      /** Host-owned chat tab identity, derived from a reserved pane or minted; absent on older hosts. Placement stays client-owned. */
      tabId?: string
    }
  | {
      kind: 'terminal'
      handle: string
      /** Host-minted tabId:leafId identity lets clients resolve the created pane; placement stays client-owned. Absent for reused PTYs or runtimes unable to report it. */
      paneKey?: string
    }
/** Report delivery precisely: under-claiming risks a resend, while over-claiming silently loses the prompt. */
export type AgentLaunchPromptOutcome = AgentLaunchPromptDisposal['outcome']

/** A journaled result must name its committed message; other delivery outcomes have none. */
export type AgentLaunchPromptDisposal =
  /** Committed to the session's transcript, which `messageId` names. */
  | { outcome: 'journaled'; messageId: string }
  /** Handed to a launch command/live PTY; no journal row exists. Never resend or the agent receives a second turn. */
  | { outcome: 'handed-to-terminal' }
  /** Not delivered by this call; the caller still owns the text. */
  | { outcome: 'not-delivered' }
  /** Replay only: the host stopped mid-delivery, so never resend. Requires agent.launch.prompt-unconfirmed.v1; older clients receive agent_session_operation_unknown. */
  | { outcome: 'unconfirmed' }

export type AgentLaunchPromptReceipt = {
  delivery: AgentLaunchPromptDelivery
} & AgentLaunchPromptDisposal

export type AgentLaunchResult = {
  outcome: AgentLaunchOutcome
  /** The workspace the agent runs in, resolved or created. */
  worktreeId: string
  /** Keep partial workspace/surface failures in one top-level warning for both launch modes; callers must surface incomplete creation. */
  warning?: string
  /** Why the outcome is what it is — always populated, so a downgrade is never silent. */
  receipt: AgentLaunchModeReceipt
  prompt?: AgentLaunchPromptReceipt
  /** Absent when no window placed the tab: an older host, no requested placement, or a host with no
   *  window owning the layout. */
  placement?: AgentLaunchPlacementReceipt
}

export type AgentLaunchMode = 'structured' | 'terminal'

/** Why a launch ran in the mode it did. `user_default` is the preference being honoured and
 *  `requested` the caller's explicit pick; every other member is a reason a chat could not run. */
export type AgentLaunchModeReason =
  | 'user_default'
  | 'requested'
  | 'remote_execution_host'
  | 'reused_terminal'
  | 'agent_without_structured_session'
  /** Historical name, kept because receipts carry it: the launch asked for a start directory
   *  outside its workspace. A custom launch command no longer produces it. */
  | 'tui_launch_command'
  | 'structured_sessions_unavailable'
  | 'structured_support_unknown'
  | 'wsl_execution_runtime'
  | 'codex_on_windows'
  | 'structured_unsupported_on_host'
  | 'chat_runtime_not_installed'

/** Restates `WorkerStartModeReceipt` in surface-neutral terms so orchestration's receipt and a
 *  mobile or renderer launch report the same vocabulary. */
export type AgentLaunchModeReceipt = {
  /** The mode the launch actually ran in. */
  mode: AgentLaunchMode
  /** The caller's explicit pick, else the user's settings default for a new agent tab. */
  preferred: AgentLaunchMode
  reason: AgentLaunchModeReason
  /** One sentence, always present, so a fallback is never silent. */
  detail: string
}

/** Validate durable replay fields beside their types; absent optional fields remain compatible with older stored rows. */
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
    (result.prompt === undefined || isAgentLaunchPromptReceipt(result.prompt)) &&
    (result.placement === undefined || isAgentLaunchPlacementReceipt(result.placement))
  )
}

function isAgentLaunchPlacementReceipt(value: unknown): value is AgentLaunchPlacementReceipt {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowing an unknown for field-by-field validation; every field read below is checked before use.
  const placement = value as Partial<AgentLaunchPlacementReceipt>
  // A fallback word this build does not know still reads: placement is a report, not a gate.
  return (
    typeof placement.groupId === 'string' &&
    (placement.fallback === undefined || typeof placement.fallback === 'string')
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
    : value.outcome === 'handed-to-terminal' ||
        value.outcome === 'not-delivered' ||
        value.outcome === 'unconfirmed'
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
    tabId?: unknown
  }
  if (typeof outcome.handle !== 'string' || outcome.handle.length === 0) {
    return false
  }
  return outcome.kind === 'terminal'
    ? // Accept optional pane identity without stricter parsing than the writer; older/no-pane outcomes must replay.
      outcome.paneKey === undefined || typeof outcome.paneKey === 'string'
    : outcome.kind === 'structured' &&
        typeof outcome.sessionId === 'string' &&
        outcome.sessionId.length > 0 &&
        // Optional on the same terms as the terminal arm's `paneKey`.
        (outcome.tabId === undefined || typeof outcome.tabId === 'string')
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

/** Create payloads cannot carry agent fields that bypass the host's launch router. */
export const AGENT_LAUNCH_RESERVED_CREATE_FIELDS = [
  'startupAgent',
  'startupCommand',
  'startupPrompt',
  'startupDraft',
  'startupLaunchConfig',
  'startupEnv',
  'startupCommandDelivery',
  'launchSource'
] as const

/** Strip legacy startup fields so migrating create callers cannot recreate the agent-first route. */
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
