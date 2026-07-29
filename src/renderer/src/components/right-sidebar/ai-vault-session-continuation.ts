import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { resolveAiVaultSessionDisplayTitle } from '../../../../shared/ai-vault-session-display-title'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

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
  orcaCustomTitle?: string | null
}): AgentSessionContinuationRequest {
  const { session, targetWorktreeId, targetWorkspacePath, orcaCustomTitle } = args
  return {
    source: {
      capturedText: previewTranscript(session),
      sourceAgent: session.agent,
      sourceTitle: resolveAiVaultSessionDisplayTitle(session.title, orcaCustomTitle),
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
