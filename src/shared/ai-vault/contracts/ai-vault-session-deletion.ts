import type { AiVaultAgent } from './ai-vault-types'
import type { ExecutionHostId } from '../../execution-host/execution-host'

// IPC payload for aiVault:deleteSession.
export type AiVaultDeleteSessionArgs = {
  agent: AiVaultAgent
  // Mixed-version optional field; delete validates path/host/agent only, never session identity/liveness.
  sessionId?: string
  filePath: string
  // The session's host; a runtime-hosted session is deleted by that host.
  executionHostId?: ExecutionHostId
  // The pairing the user confirmed against; a same-id re-pair to another machine must not receive it.
  expectedEnvironmentPairingRevision?: number
}

export type AiVaultDeleteSessionResult =
  | { outcome: 'deleted' }
  | { outcome: 'rejected'; agent: AiVaultAgent; reason: AiVaultSessionDeleteRejectionCode }
  | { outcome: 'failed'; agent: AiVaultAgent; error: string }

// Agents whose transcript is a discoverable file or directory under the scanned roots.
export const AI_VAULT_FILE_DELETABLE_AGENTS = [
  'copilot',
  'cursor',
  'devin',
  'openclaw',
  'droid',
  'pi',
  'omp',
  'claude',
  'codebuddy',
  'rovo',
  'grok',
  'cline'
] as const satisfies readonly AiVaultAgent[]

export type AiVaultFileDeletableAgent = (typeof AI_VAULT_FILE_DELETABLE_AGENTS)[number]

// Every agent the UI may offer Delete for: file transcripts, Codex rollouts through `codex delete`,
// and OpenCode 2 rows through `opencode session delete`. Excludes Antigravity/Kimi registries (no
// stable session IDs), OpenCode 1 legacy rows (the current CLI reports success without removing
// them), and SQLite stores without a delete command (Hermes, ZCode).
export const AI_VAULT_DELETABLE_AGENTS = [
  ...AI_VAULT_FILE_DELETABLE_AGENTS,
  'codex',
  'opencode2'
] as const satisfies readonly AiVaultAgent[]

export type AiVaultDeletableAgent = (typeof AI_VAULT_DELETABLE_AGENTS)[number]

export function isAiVaultDeletableAgent(agent: AiVaultAgent): agent is AiVaultDeletableAgent {
  return AI_VAULT_DELETABLE_AGENTS.some((deletable) => deletable === agent)
}

export function isAiVaultFileDeletableAgent(
  agent: AiVaultAgent
): agent is AiVaultFileDeletableAgent {
  return AI_VAULT_FILE_DELETABLE_AGENTS.some((deletable) => deletable === agent)
}

export type AiVaultDatabaseRowAgent = 'opencode2'

export function isAiVaultDatabaseRowAgent(agent: AiVaultAgent): agent is AiVaultDatabaseRowAgent {
  return agent === 'opencode2'
}

// OpenCode 1.17.x uses synthetic dbPath#sessionId identities, never real transcript files to open/delete.
export function isAiVaultSyntheticSessionPath(filePath: string): boolean {
  return filePath.includes('#')
}

export const AI_VAULT_SESSION_DELETE_REJECTION_CODES = [
  'invalid-path',
  'unsupported-agent',
  'non-local-host',
  // The owning host predates aiVault.deleteSession.
  'host-update-required',
  'synthetic-path',
  'path-outside-known-roots',
  // Codex refuses to delete a thread another process has open.
  'session-in-use',
  // Reject paths the scanner would not surface (wrong extensions or pruned subagents).
  'undiscoverable-path',
  // A root-level file does not name a session directory; deleting its parent would erase every session.
  'no-session-directory',
  // fs-side guard: lstat disagrees with the removal's declared kind (a symlink,
  // or a file where the plan expects a directory).
  'unexpected-target-kind'
] as const

export type AiVaultSessionDeleteRejectionCode =
  (typeof AI_VAULT_SESSION_DELETE_REJECTION_CODES)[number]

// Reject disk-kind mismatches; realpath must remain inside roots because symlinked parents can escape textual checks.
export type AiVaultSessionDeleteRemoval = {
  path: string
  kind: 'file' | 'directory'
  roots: readonly string[]
}

// CALLER CONTRACT: allowed is path-only. Before removal recheck kind and realpath containment in roots to reject same-named directories/symlinks.
export type AiVaultSessionDeleteAllowedResult = {
  allowed: true
  agent: AiVaultFileDeletableAgent
  // The transcript path (also the last `removals` entry); cache invalidation
  // keys off it.
  resolvedPath: string
  // Remove companions before the transcript so failures leave an on-screen row to retry instead of stranding companions.
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
