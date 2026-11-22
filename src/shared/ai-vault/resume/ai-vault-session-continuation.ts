import type { AgentSessionContinuationRequest } from '../../agent-session/conversation-context/agent-session-continuation'
import type { AiVaultSession, AiVaultSessionPreviewMessage } from '../contracts/ai-vault-types'
import { isAiVaultDatabaseAgent } from '../contracts/ai-vault-session-handoff'

export function canContinueAiVaultSessionInNewSession(
  session: AiVaultSession,
  targetWorktreeId: string | null | undefined
): boolean {
  return Boolean(
    targetWorktreeId &&
    // A database row's host saves its conversation when Hand Off opens, even with no preview text.
    (isAiVaultDatabaseAgent(session.agent) ||
      vaultTranscriptPath(session) ||
      session.previewMessages.some((message) => message.text.trim()))
  )
}

/** The History row fields a hand-off reads; a phone sends exactly these to its host. */
export type AiVaultContinuationSession = Pick<
  AiVaultSession,
  'agent' | 'title' | 'cwd' | 'filePath' | 'lastUserPrompt'
> & { previewMessages: readonly Pick<AiVaultSessionPreviewMessage, 'role' | 'text'>[] }

export type AiVaultSessionContinuationTarget = {
  session: AiVaultContinuationSession
  targetWorktreeId: string
  targetWorkspacePath: string
}

export function prepareAiVaultSessionContinuation(
  args: AiVaultSessionContinuationTarget & {
    /** This conversation's own hand-off snapshot, for database-backed rows. */
    savedTranscriptPath?: string
  }
): AgentSessionContinuationRequest {
  const { session, targetWorktreeId, targetWorkspacePath } = args
  return {
    source: {
      capturedText: previewTranscript(session),
      sourceAgent: session.agent,
      sourceTitle: session.title,
      sourceWorkingDirectory: session.cwd,
      transcriptPath: args.savedTranscriptPath ?? vaultTranscriptPath(session),
      // Use provider-authenticated prompts; preview user entries may contain tool results or injected skills.
      lastPrompt: session.lastUserPrompt ?? null,
      lastAssistantMessage: latestAssistantPreview(session)
    },
    worktreeId: targetWorktreeId,
    workspacePath: targetWorkspacePath,
    // Preserve recorded cwd even when the original worktree selection is gone.
    initialCwd: session.cwd || targetWorkspacePath,
    launchSource: 'sidebar'
  }
}

function latestAssistantPreview(session: AiVaultContinuationSession): string | null {
  return session.previewMessages.findLast((message) => message.role === 'assistant')?.text ?? null
}

function previewTranscript(session: AiVaultContinuationSession): string {
  return session.previewMessages
    .filter((message) => message.text.trim())
    .map((message) => `${message.role}: ${message.text.trim()}`)
    .join('\n\n')
}

function vaultTranscriptPath(session: Pick<AiVaultSession, 'agent' | 'filePath'>): string | null {
  // These rows name an account-wide database; handing that path over would expose every conversation in it.
  if (isAiVaultDatabaseAgent(session.agent)) {
    return null
  }
  return session.filePath.trim() || null
}
