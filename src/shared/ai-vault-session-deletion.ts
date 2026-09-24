import type { AiVaultAgent } from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'

// IPC payload for aiVault:deleteSession.
export type AiVaultDeleteSessionArgs = {
  agent: AiVaultAgent
  // Optional for mixed renderer/main versions, and never authoritative: main
  // resolves ownership from its own records, because a client-supplied id (or a
  // client-supplied `structuredSession`) is exactly what an out-of-date or wrong
  // caller gets wrong. Path + host + agent validation still gates the target.
  sessionId?: string
  filePath: string
  // The session's host; only a local session may be deleted.
  executionHostId?: ExecutionHostId
}

export type AiVaultDeleteSessionResult =
  | { outcome: 'deleted' }
  | {
      outcome: 'rejected'
      agent: AiVaultAgent
      reason: AiVaultSessionDeleteRejectionCode
      // Present only for 'structured-session-owned', so the refusal can offer the
      // chat instead of a dead end. Host-derived; never echoed from the request.
      structuredSession?: { sessionId: string; workspaceId: string }
    }
  | { outcome: 'failed'; agent: AiVaultAgent; error: string }

// Agents whose sessions Orca can remove completely: everything the session
// wrote is derivable from the one path the scanner surfaced, and none of it is
// shared with another session.
//
// The rest are excluded, recorded here because the UI deliberately won't say
// why (a provider's storage layout is Orca's problem, not the reader's):
// - antigravity, kimi: a separate registry (history.jsonl / session_index.jsonl)
//   would keep a dangling entry. Antigravity's carries no conversation id, so
//   which line to drop can't be determined at all.
// - codex: session_index.jsonl plus hardlink aliases between the Orca-managed
//   home and ~/.codex, so a one-sided delete reappears on the next scan.
// - opencode 1.17.x: a SQLite row, not a file.
export const AI_VAULT_DELETABLE_AGENTS = [
  'gemini',
  'copilot',
  'cursor',
  'hermes',
  'devin',
  'openclaw',
  'droid',
  'pi',
  'omp',
  'claude',
  'rovo',
  'grok',
  'cline'
] as const satisfies readonly AiVaultAgent[]

export type AiVaultDeletableAgent = (typeof AI_VAULT_DELETABLE_AGENTS)[number]

export function isAiVaultDeletableAgent(agent: AiVaultAgent): agent is AiVaultDeletableAgent {
  return (AI_VAULT_DELETABLE_AGENTS as readonly AiVaultAgent[]).includes(agent)
}

// A '#' marks an OpenCode 1.17.x SQLite row's synthetic `<dbPath>#<sessionId>`
// identity — no real file to open or delete. '#' never appears in a genuine
// transcript path.
export function isAiVaultSyntheticSessionPath(filePath: string): boolean {
  return filePath.includes('#')
}

export type AiVaultSessionDeleteRejectionCode =
  | 'invalid-path'
  | 'unsupported-agent'
  | 'non-local-host'
  | 'synthetic-path'
  | 'path-outside-known-roots'
  // The scanner would never have surfaced this path as a session row, so it is
  // not a session to delete (wrong extension, or a pruned subagent transcript).
  | 'undiscoverable-path'
  // A directory-shaped agent's file sits directly in the sessions root, so it
  // names no session dir of its own — removing it would trash every session.
  | 'no-session-directory'
  // fs-side guard: lstat disagrees with the removal's declared kind (a symlink,
  // or a file where the plan expects a directory).
  | 'unexpected-target-kind'
  // A structured session record names this transcript. Refused whether or not
  // its lease currently admits a writer: a recovering owner still owns its
  // history, and "not admitting right now" is not evidence it is safe to destroy.
  | 'structured-session-owned'
  // Ownership could not be established, so absence is not an answer: no host, an
  // unreadable or backup-derived catalogue, a quarantined record, or a transcript
  // reachable under aliases this check cannot enumerate.
  | 'structured-session-ownership-unknown'

// One path the executor removes. A `kind` mismatch on disk is a rejection,
// never a coerced delete. `roots` are what the path's realpath must still
// resolve inside — a symlinked parent escapes the validator's textual check.
export type AiVaultSessionDeleteRemoval = {
  path: string
  kind: 'file' | 'directory'
  roots: readonly string[]
}

// CALLER CONTRACT: `allowed: true` is a path-only judgement — the validator
// never touches disk, so it can't tell a session file from a same-named
// directory or a symlink planted inside a root. Before removing anything the
// caller MUST re-check each removal's `kind` and realpath it against `roots`.
export type AiVaultSessionDeleteAllowedResult = {
  allowed: true
  agent: AiVaultDeletableAgent
  // The transcript path (also the last `removals` entry); cache invalidation
  // keys off it.
  resolvedPath: string
  // Companions first, transcript last: a failed companion leaves the row on
  // screen to retry from, where transcript-first would strand it on disk.
  removals: readonly AiVaultSessionDeleteRemoval[]
}

export type AiVaultSessionDeleteRejectedResult = {
  allowed: false
  agent: AiVaultAgent
  reason: AiVaultSessionDeleteRejectionCode
}

export type AiVaultSessionDeleteValidationResult =
  | AiVaultSessionDeleteAllowedResult
  | AiVaultSessionDeleteRejectedResult
