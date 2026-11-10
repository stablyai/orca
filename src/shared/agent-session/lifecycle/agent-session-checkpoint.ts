// Per-turn file checkpoints: the host snapshots the chat's worktree before each turn starts, and
// "Rewind to here" can put the files back. Shared by the host and every client.

export type AgentSessionCheckpointUnavailableReason =
  /** No snapshot for this message: sent before checkpoints existed, or pruned. */
  | 'none'
  /** The chat's folder is not a git worktree. */
  | 'not-a-repo'
  /** The host could not read the worktree (or does not support checkpoints). */
  | 'unavailable'

export type AgentSessionCheckpointPreview =
  | { available: false; reason: AgentSessionCheckpointUnavailableReason }
  | {
      available: true
      /** Files whose content differs between the worktree now and the snapshot. */
      changedFiles: number
      /** Commits were made after the snapshot; they stay on the branch. */
      headMoved: boolean
      createdAt: number
      /** An agent is working in this workspace now, so a restore would refuse. */
      busy?: boolean
    }

export type AgentSessionCheckpointRestoreResult = {
  changedFiles: number
  headMoved: boolean
  /** Restores the files as they were right before this restore. */
  undoId: string
}

/** Why a restore refused before changing any file. */
export const AGENT_SESSION_CHECKPOINT_RESTORE_REFUSALS = [
  'none',
  'not-a-repo',
  'busy',
  'merge-conflicts',
  'blocked-path',
  'unsafe-path',
  /** Not a refusal: some files changed before the restore failed; the error names the undo id. */
  'partial'
] as const
export type AgentSessionCheckpointRestoreRefusal =
  (typeof AGENT_SESSION_CHECKPOINT_RESTORE_REFUSALS)[number]

const REFUSAL_PREFIX = 'agent_session_checkpoint_'

export function agentSessionCheckpointRefusalMessage(
  reason: AgentSessionCheckpointRestoreRefusal
): string {
  return `${REFUSAL_PREFIX}${reason}`
}

/** Reads the refusal out of an RPC error message; null for any other failure. */
export function agentSessionCheckpointRefusalOf(
  error: unknown
): AgentSessionCheckpointRestoreRefusal | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const match = /agent_session_checkpoint_([a-z-]+)/.exec(message)
  const reason = match?.[1]
  return AGENT_SESSION_CHECKPOINT_RESTORE_REFUSALS.find((value) => value === reason) ?? null
}

export function agentSessionCheckpointPartialMessage(undoId: string): string {
  return `${REFUSAL_PREFIX}partial undo=${undoId}`
}

/** The undo id a partial restore names, so the client can still offer Undo. */
export function agentSessionCheckpointPartialUndoIdOf(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const undoId = /agent_session_checkpoint_partial undo=([0-9]+-[0-9a-f]+)/.exec(message)?.[1]
  return undoId && AGENT_SESSION_CHECKPOINT_UNDO_ID.test(undoId) ? undoId : null
}

/** Undo ids are the last segment of a host-generated ref name. */
export const AGENT_SESSION_CHECKPOINT_UNDO_ID = /^[0-9]{1,16}-[0-9a-f]{8}$/
