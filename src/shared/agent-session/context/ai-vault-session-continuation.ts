import type { AiVaultSession } from '../../ai-vault/contracts/ai-vault-types'
import { isAiVaultDatabaseAgent } from '../../ai-vault/contracts/ai-vault-session-handoff'
import type { AgentSessionContinuationRequest } from './agent-session-continuation'

export function prepareAiVaultSessionContinuation(args: {
  session: AiVaultSession
  targetWorktreeId: string
  targetWorkspacePath: string
  /** This conversation's own hand-off snapshot, for database-backed rows. */
  savedTranscriptPath?: string
}): AgentSessionContinuationRequest {
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

function latestAssistantPreview(session: AiVaultSession): string | null {
  return session.previewMessages.findLast((message) => message.role === 'assistant')?.text ?? null
}

function previewTranscript(session: AiVaultSession): string {
  return session.previewMessages
    .filter((message) => message.text.trim())
    .map((message) => `${message.role}: ${message.text.trim()}`)
    .join('\n\n')
}

function vaultTranscriptPath(session: AiVaultSession): string | null {
  // These rows name an account-wide database; handing that path over would expose every conversation in it.
  if (isAiVaultDatabaseAgent(session.agent)) {
    return null
  }
  return session.filePath.trim() || null
}
