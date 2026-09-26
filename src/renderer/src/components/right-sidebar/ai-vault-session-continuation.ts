import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  isKnownAiVaultResumeWorkspaceTarget,
  type AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'
import {
  canJumpToAiVaultSessionWorktree,
  type AiVaultSessionWorktreeInfo
} from './ai-vault-session-worktree'

/**
 * Where the continuation dialog opens by default. Unlike resume, this ignores
 * host identity: the dialog's target picker owns that choice, and bridging the
 * transcript is what makes another host viable.
 */
export function resolveAiVaultContinuationWorkspaceId(args: {
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  activeWorktreeId: string | null
  state: AiVaultSessionResumeTargetState
}): string | null {
  const sessionWorkspaceId = canJumpToAiVaultSessionWorktree(args.worktreeInfo)
    ? (args.worktreeInfo?.worktreeId ?? null)
    : null
  const candidates = [sessionWorkspaceId, args.activeWorktreeId]
  return (
    candidates.find(
      (candidate): candidate is string =>
        Boolean(candidate) && isKnownAiVaultResumeWorkspaceTarget(args.state, candidate)
    ) ?? null
  )
}

export function canContinueAiVaultSessionInNewSession(
  session: AiVaultSession,
  targetWorktreeId: string | null | undefined
): boolean {
  return Boolean(
    targetWorktreeId &&
    (session.filePath.trim() || session.previewMessages.some((message) => message.text.trim()))
  )
}

export function prepareAiVaultSessionContinuation(args: {
  session: AiVaultSession
  targetWorktreeId: string
  targetWorkspacePath: string
}): AgentSessionContinuationRequest {
  const { session, targetWorktreeId, targetWorkspacePath } = args
  return {
    origin: {
      agent: session.agent,
      sessionId: session.sessionId,
      transcriptPath: session.filePath.trim() || null,
      executionHostId: session.executionHostId
    },
    source: {
      capturedText: previewTranscript(session),
      sourceAgent: session.agent,
      sourceTitle: session.title,
      sourceWorkingDirectory: session.cwd,
      transcriptPath: session.filePath.trim() || null,
      // Why: preview user entries can be tool results or injected skill text; only provider-authenticated prompts are safe hints.
      lastPrompt: session.lastUserPrompt ?? null,
      lastAssistantMessage: latestAssistantPreview(session)
    },
    worktreeId: targetWorktreeId,
    workspacePath: targetWorkspacePath,
    // Why: sessions can outlive their worktree selection, but continuation should preserve their recorded cwd.
    initialCwd: session.cwd || targetWorkspacePath,
    launchSource: 'sidebar'
  }
}

function latestAssistantPreview(session: AiVaultSession): string | null {
  return session.previewMessages.findLast((message) => message.role === 'assistant')?.text ?? null
}

function previewTranscript(session: AiVaultSession): string {
  return session.previewMessages
    .filter((message) => message.text.trim())
    .map((message) => `${message.role}: ${message.text.trim()}`)
    .join('\n\n')
}
