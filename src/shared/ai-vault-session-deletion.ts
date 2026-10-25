import type { AiVaultAgent } from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'

// IPC payload for aiVault:deleteSession.
export type AiVaultDeleteSessionArgs = {
  agent: AiVaultAgent
  // Mixed-version optional field; delete validates path/host/agent only, never session identity/liveness.
  sessionId?: string
  filePath: string
  // The session's host; only a local session may be deleted.
  executionHostId?: ExecutionHostId
}

export type AiVaultDeleteSessionResult =
  | { outcome: 'deleted' }
  | { outcome: 'rejected'; agent: AiVaultAgent; reason: AiVaultSessionDeleteRejectionCode }
  | { outcome: 'failed'; agent: AiVaultAgent; error: string }

// Allow only sessions whose complete unshared data is derivable from the scanned path.
// Exclude Antigravity/Kimi registries (Antigravity lacks IDs), Codex indexes/hardlink aliases (one-sided deletion reappears), and OpenCode 1.17.x SQLite rows.
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
  'codebuddy',
  'rovo',
  'grok',
  'cline'
] as const satisfies readonly AiVaultAgent[]

export type AiVaultDeletableAgent = (typeof AI_VAULT_DELETABLE_AGENTS)[number]

export function isAiVaultDeletableAgent(agent: AiVaultAgent): agent is AiVaultDeletableAgent {
  return (AI_VAULT_DELETABLE_AGENTS as readonly AiVaultAgent[]).includes(agent)
}

// OpenCode 1.17.x uses synthetic dbPath#sessionId identities, never real transcript files to open/delete.
export function isAiVaultSyntheticSessionPath(filePath: string): boolean {
  return filePath.includes('#')
}

export type AiVaultSessionDeleteRejectionCode =
  | 'invalid-path'
  | 'unsupported-agent'
  | 'non-local-host'
  | 'synthetic-path'
  | 'path-outside-known-roots'
  // Reject paths the scanner would not surface (wrong extensions or pruned subagents).
  | 'undiscoverable-path'
  // A root-level file does not name a session directory; deleting its parent would erase every session.
  | 'no-session-directory'
  // fs-side guard: lstat disagrees with the removal's declared kind (a symlink,
  // or a file where the plan expects a directory).
  | 'unexpected-target-kind'

// Reject disk-kind mismatches; realpath must remain inside roots because symlinked parents can escape textual checks.
export type AiVaultSessionDeleteRemoval = {
  path: string
  kind: 'file' | 'directory'
  roots: readonly string[]
}

// CALLER CONTRACT: allowed is path-only. Before removal recheck kind and realpath containment in roots to reject same-named directories/symlinks.
export type AiVaultSessionDeleteAllowedResult = {
  allowed: true
  agent: AiVaultDeletableAgent
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
