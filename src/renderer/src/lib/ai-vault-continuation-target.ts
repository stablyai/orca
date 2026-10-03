import {
  isSupportedAiVaultResumeTargetStatus,
  isWslStoredAiVaultSessionFile,
  type AiVaultResumeTargetStatus
} from './ai-vault-resume-target'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

/**
 * How the prior session's context can reach the chosen target host.
 *
 * Continuation only needs the transcript *text*, so unlike `--resume` it does
 * not require the provider session file to already sit on the target host.
 */
export type AiVaultContinuationBridge =
  | { kind: 'same-host' }
  | { kind: 'transfer'; sourceConnectionId: string | null; targetConnectionId: string | null }
  /**
   * Carry the context in the prompt itself. `transcript-tail` re-reads the real
   * transcript from its host; `preview` is the thin vault preview, all that is
   * left when the transcript file cannot be reached at all.
   */
  | { kind: 'inline'; content: 'transcript-tail' | 'preview' }
  | { kind: 'unavailable'; reason: AiVaultContinuationBlockedReason }

export type AiVaultContinuationBlockedReason = 'target-unsupported'

/**
 * Hosts whose transcripts we can reach at an arbitrary absolute path. Runtime
 * (paired-server) file RPCs are worktree-relative, so a transcript stored under
 * the remote home is out of reach in both directions.
 */
function canReachHostTranscriptFile(hostId: ExecutionHostId | null): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'local' || parsed?.kind === 'ssh'
}

function getSshConnectionId(hostId: ExecutionHostId | null): string | null {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' ? parsed.targetId : null
}

/**
 * Vault sessions with no recorded host were scanned from this machine's disk.
 */
function getEffectiveSessionHostId(hostId: ExecutionHostId | null): ExecutionHostId {
  return hostId ?? LOCAL_EXECUTION_HOST_ID
}

function getEffectiveTargetHostId(
  hostId: ExecutionHostId | null,
  targetStatus: AiVaultResumeTargetStatus
): ExecutionHostId | null {
  if (hostId) {
    return hostId
  }
  // Why: an SSH/runtime target with no resolved host id gives us no connection
  // to write through, so it must not be inferred as local.
  return targetStatus === 'local' ? LOCAL_EXECUTION_HOST_ID : null
}

export function resolveAiVaultContinuationBridge(args: {
  sessionFilePath: string | null | undefined
  sessionExecutionHostId?: ExecutionHostId | null
  targetStatus: AiVaultResumeTargetStatus
  targetExecutionHostId?: ExecutionHostId | null
}): AiVaultContinuationBridge {
  if (!isSupportedAiVaultResumeTargetStatus(args.targetStatus)) {
    return { kind: 'unavailable', reason: 'target-unsupported' }
  }

  const sessionHostId = getEffectiveSessionHostId(
    normalizeExecutionHostId(args.sessionExecutionHostId)
  )
  const targetHostId = getEffectiveTargetHostId(
    normalizeExecutionHostId(args.targetExecutionHostId),
    args.targetStatus
  )

  // Why: with no stored transcript the prompt already inlines bounded preview
  // text, which travels to any host without a file transfer.
  if (!args.sessionFilePath?.trim()) {
    return { kind: 'inline', content: 'preview' }
  }

  if (targetHostId && sessionHostId === targetHostId) {
    return { kind: 'same-host' }
  }

  // Why: SSH-to-local-WSL setups (#6270) tag the session 'local' while the file
  // lives under a WSL UNC path any SSH shell into this machine can already read.
  if (args.targetStatus === 'ssh' && isWslStoredAiVaultSessionFile(args.sessionFilePath)) {
    return { kind: 'same-host' }
  }

  // Why: an unreadable transcript is a weaker handoff, never a blocked one — the
  // vault preview still travels, and continuing beats refusing.
  if (!canReachHostTranscriptFile(sessionHostId)) {
    return { kind: 'inline', content: 'preview' }
  }
  // Why: paired-server targets accept no file outside their worktree, so the
  // transcript rides inside the prompt instead of being copied over.
  if (!canReachHostTranscriptFile(targetHostId)) {
    return { kind: 'inline', content: 'transcript-tail' }
  }

  return {
    kind: 'transfer',
    sourceConnectionId: getSshConnectionId(sessionHostId),
    targetConnectionId: getSshConnectionId(targetHostId)
  }
}

export function canContinueAiVaultSessionOnTarget(
  args: Parameters<typeof resolveAiVaultContinuationBridge>[0]
): boolean {
  return resolveAiVaultContinuationBridge(args).kind !== 'unavailable'
}
