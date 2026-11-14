import {
  buildAgentSessionContinuationPrompt,
  type AgentSessionContinuationRequest
} from '@/lib/agent-session/context/agent-session-continuation'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS,
  isAiVaultDatabaseAgent
} from '../../../../../../shared/ai-vault/contracts/ai-vault-session-handoff'
import { withTimeout } from '../../../../../../shared/promise-timeout-fallback'

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

type AiVaultSessionContinuationTarget = {
  session: AiVaultSession
  targetWorktreeId: string
  targetWorkspacePath: string
}

/** A database row's host saves this one conversation first; null when nothing usable came back. */
export async function loadDatabaseAiVaultSessionContinuation(
  target: AiVaultSessionContinuationTarget
): Promise<AgentSessionContinuationRequest | null> {
  const { session } = target
  const saved = await withTimeout(
    window.api.aiVault.prepareSessionHandoff({
      agent: session.agent,
      filePath: session.filePath,
      sessionId: session.sessionId,
      executionHostId: session.executionHostId
    }),
    AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS,
    {}
  )
  const request = prepareAiVaultSessionContinuation({
    ...target,
    savedTranscriptPath: saved.transcriptPath
  })
  return buildAgentSessionContinuationPrompt(request.source, 'focused') ? request : null
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
