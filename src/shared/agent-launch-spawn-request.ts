// Client-safe nested `agentLaunch` request carried by pty:spawn IPC and the
// terminal-create RPC schemas (U3). It names only the requested agent identity
// and the interactive prompt/launch policy — never a command, env, launch
// config, or resolved argv. When present, the host IGNORES any client-supplied
// command/launchConfig/launchAgent/env and resolves the launch itself through
// the host boundary. The host constructs LaunchIntent/AgentReferenceAuthority
// from its authenticated context; this shape never carries either.

import type { TuiAgent } from './types'
import type {
  AgentLaunchFailure,
  AgentLaunchReceipt,
  AgentLaunchRequestError
} from './agent-launch-contract'
import type { AgentSessionOwnershipKey } from './agent-session-resume'
import type { AiVaultAgent } from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'

/** Requested agent identity, or the host's stored default. A custom id is only
 *  admitted on THIS field, never the legacy launchAgent field. */
export type AgentLaunchSelectionRequest = { kind: 'agent'; agent: TuiAgent } | { kind: 'default' }

/** Names a host-verified saved owner whose stored prompt/reference authority a
 *  launch may use. Clients supply the owner locator only; the host validates it
 *  and classifies prompt authority. The full mobile/paired variant set lands
 *  with U7's host-owned mobile launch — Wave 1 accepts the owner locator shape
 *  so the wire contract is stable. */
export type AgentLaunchSourceRecord = {
  owner:
    | 'default'
    | 'quick-command'
    | 'commit-message'
    | 'source-control-recipe'
    | 'session'
    | 'workspace'
  id?: string
}

/** Ids-free client declaration that a spawn is an UNATTENDED background launch
 *  with no automation run / orchestration dispatch to own its failure (§U6,
 *  ledger #8/#13). The client NEVER sends a LaunchIntent or attemptId: it only
 *  declares the kind, and the HOST mints the attemptId, creates the generic
 *  background attempt before resolution, and constructs the
 *  LaunchIntent {kind:'background', attemptId, worktreeId} itself. A misdeclaration
 *  only shifts admission cap buckets; the host may reclassify. */
export type AgentLaunchUnattendedDeclaration = { kind: 'background' }

export type AgentLaunchSpawnRequest = {
  selection: AgentLaunchSelectionRequest
  /** Current interactive draft; the host applies its per-surface maximum. */
  prompt?: string
  /** Launch a bare TUI when the prompt is empty (e.g. tab.newAgent). */
  allowEmptyPromptLaunch?: boolean
  /** 'draft' lands the prompt UNSUBMITTED in the agent's input (native flag/env,
   *  or host-returned draftPrompt for post-ready paste); default 'submit'. */
  promptDelivery?: 'submit' | 'draft'
  sourceRecord?: AgentLaunchSourceRecord
  /** Args the user edited but chose NOT to save, applied INSTEAD of the stored
   *  agentArgs of a 'source-control-recipe' sourceRecord. Still not a resolved
   *  argv: the host tokenizes/validates it exactly like the stored recipe args.
   *  Degrades per wire rule 1 — a host predating this field ignores it and
   *  launches the stored recipe args, so the edited args are best-effort and a
   *  client must never report them as applied, only that the launch happened. */
  unsavedAgentArgs?: string
  /** Present only for an unattended background launch; the host mints the attempt
   *  identity from its authenticated context. Absent = an interactive launch. */
  unattended?: AgentLaunchUnattendedDeclaration
}

/** Provider-session resume/fork variant, distinct from AgentLaunchSpawnRequest.
 *  It names only the session ownership key: the host loads the private record
 *  (snapshot/legacy config) and resolves the launch, ignoring any client prompt,
 *  command, env, or launch config. `fork` copies the snapshot and appends the
 *  provider resume argv once; its draft rides the returned draftPrompt into the
 *  renderer paste writer. Unknown/ambiguous key → invalid_launch_snapshot.
 *  Context forks are NOT this variant — they are a plain identity-only
 *  AgentLaunchSpawnRequest carrying the scrollback as a 'draft' prompt. */
export type AgentLaunchResumeRequest = {
  resume: {
    operation: 'resume' | 'fork'
    sessionKey: AgentSessionOwnershipKey
  }
}

/** AI Vault session resume/copy variant (U5 FULL PORT). The client echoes the
 *  host listing's OWN discovered entry identity — it never authors locator data.
 *  The host re-validates that identity against a FRESH `runtime.listAiVaultSessions`
 *  discovery and rebuilds the resume command itself, bypassing the resolver like
 *  legacy opaque replay (no admission token/receipt). An entry the host's own
 *  fresh scan does not contain, or a field mismatch, is `invalid_launch_snapshot`.
 *  `operation: 'resume'` rides pty:spawn/terminal-create and spawns a normal
 *  terminal; `operation: 'copy'` never spawns — it is served by the host copy
 *  method that returns the assembled command string as a display artifact (OMP's
 *  only path). `filePath` is trusted desktop IPC only (OMP transcript path); every
 *  runtime/paired RPC surface OMITS it and the host re-derives it from its own
 *  fresh entry. */
export type AgentLaunchVaultResumeEntry = {
  executionHostId: ExecutionHostId
  agent: AiVaultAgent
  sessionId: string
  resumeLocator?: string
  filePath?: string
}

export type AgentLaunchVaultResumeRequest = {
  vaultResume: {
    operation: 'resume' | 'copy'
    entry: AgentLaunchVaultResumeEntry
  }
}

/** Host result of a 'copy' vault-resume (the non-spawning path). Carries only the
 *  assembled command string as a clipboard/display artifact — never argv/env/
 *  token. An entry the host's own fresh discovery does not contain is an in-band
 *  invalid_launch_snapshot, mirroring the resume failure envelope. */
export type AgentLaunchVaultResumeCopyResult =
  | { status: 'ok'; command: string }
  | { status: 'failed'; failure: { code: 'invalid_launch_snapshot' } }

/** On-demand expanded-details disclosure of the correlated snapshot's launch
 * arguments. The executable, environment, custom id, and paths stay private. */
export type AgentLaunchVaultResumeDetailsResult =
  | { status: 'ok'; args: readonly string[] }
  | { status: 'unavailable' }

/** The agentLaunch input carried by pty:spawn / terminal-create: a fresh
 *  selection-based launch, a provider-session resume/fork by session key, or an
 *  AI Vault session resume. The host discriminates on the presence of `resume` /
 *  `vaultResume`. */
export type AgentLaunchInput =
  | AgentLaunchSpawnRequest
  | AgentLaunchResumeRequest
  | AgentLaunchVaultResumeRequest

/** Client-safe result of a host-resolved agent launch, returned alongside a
 *  spawn/terminal-create result. 'launched' carries only the receipt (never
 *  argv/env/snapshot); a pre-spawn 'failed'/'rejected' means NO PTY/terminal was
 *  created and — for RPC surfaces — is a successful response, not an error
 *  envelope, mirroring worktree.create so old-client semantics stay intact. */
export type AgentLaunchSpawnOutcome =
  | { status: 'launched'; receipt: AgentLaunchReceipt; backgroundAttemptId?: string }
  | { status: 'failed'; failure: AgentLaunchFailure; backgroundAttemptId?: string }
  | { status: 'rejected'; requestError: AgentLaunchRequestError }
