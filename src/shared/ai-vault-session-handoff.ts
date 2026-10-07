import type { ExecutionHostId } from './execution-host'

/** Transcripts larger than this are not moved between hosts; a bounded tail travels instead. */
export const AI_VAULT_HANDOFF_MAX_TRANSFER_BYTES = 8 * 1024 * 1024

/** Same limit, phrased for the dialog that has to explain it. */
export const AI_VAULT_HANDOFF_MAX_TRANSFER_MB = `${AI_VAULT_HANDOFF_MAX_TRANSFER_BYTES / (1024 * 1024)} MB`

export type AiVaultSessionHandoffRequest = {
  agent: string
  sessionId: string
  sourceFilePath: string
  sourceExecutionHostId?: ExecutionHostId | null
  targetExecutionHostId?: ExecutionHostId | null
  /**
   * 'file' copies the transcript onto the target host; 'text' returns a bounded
   * tail for the prompt, for targets that accept no file outside their worktree.
   */
  deliver?: 'file' | 'text'
}

export type AiVaultSessionHandoffFailureReason =
  | 'binary-transcript'
  | 'source-unavailable'
  | 'target-unavailable'
  | 'invalid-request'
  | 'transfer-failed'

export type AiVaultSessionHandoffOutcome =
  /** The transcript now exists on the target host and both context modes work unchanged. */
  | { kind: 'transferred'; transcriptPath: string; byteLength: number }
  /** Too large to move; only this bounded tail travels, so 'full transcript' is unavailable. */
  | { kind: 'digest'; text: string; byteLength: number; omittedBytes: number }
  | { kind: 'failed'; reason: AiVaultSessionHandoffFailureReason; message?: string }
