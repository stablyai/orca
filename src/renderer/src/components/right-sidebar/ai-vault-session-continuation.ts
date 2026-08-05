import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getAiVaultTranscriptPath } from '../../../../shared/ai-vault-transcript-path'

// Cursor resumes by re-running its CLI in the recorded cwd, so both gating
// paths need the same triple; keep them from drifting apart.
export function hasCursorResumeTarget(
  session: Partial<Pick<AiVaultSession, 'agent' | 'cwd' | 'resumeCommand'>>,
  cursorCommandAvailable: boolean
): boolean {
  return (
    session.agent !== 'cursor' ||
    Boolean(session.cwd && session.resumeCommand?.trim() && cursorCommandAvailable)
  )
}

export function canContinueAiVaultSessionInNewSession(
  session: AiVaultSession,
  targetWorktreeId: string | null | undefined,
  cursorCommandAvailable = false
): boolean {
  if (!hasCursorResumeTarget(session, cursorCommandAvailable)) {
    return false
  }
  return Boolean(
    targetWorktreeId &&
    (getAiVaultTranscriptPath(session) ||
      session.previewMessages.some((message) => message.text.trim()))
  )
}

export function prepareAiVaultSessionContinuation(args: {
  session: AiVaultSession
  targetWorktreeId: string
  targetWorkspacePath: string
}): AgentSessionContinuationRequest {
  const { session, targetWorktreeId, targetWorkspacePath } = args
  return {
    source: {
      capturedText: previewTranscript(session),
      sourceAgent: session.agent,
      sourceTitle: session.title,
      sourceWorkingDirectory: session.cwd,
      transcriptPath: getAiVaultTranscriptPath(session),
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
