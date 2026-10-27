import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function aiVaultSearchHitToSession(
  hit: AiVaultSearchHit,
  executionHostId: ExecutionHostId
): AiVaultSession {
  const filePath = hit.source.filePath ?? ''
  const timestamp = hit.updatedAt ?? ''

  return {
    id: `${executionHostId}:${hit.agent}:${hit.sessionId}:${filePath}`,
    executionHostId,
    agent: hit.agent,
    sessionId: hit.sessionId,
    title: hit.title,
    cwd: hit.cwd,
    branch: hit.branch,
    model: null,
    filePath,
    codexHome: hit.source.codexHome ?? null,
    createdAt: null,
    updatedAt: hit.updatedAt,
    modifiedAt: timestamp,
    messageCount: hit.messageCount,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: hit.resumeCommand ?? '',
    subagent: null,
    ...(hit.structuredSession ? { structuredSession: hit.structuredSession } : {})
  }
}

/** Hits carry no turns and remote hosts cannot reparse a first prompt, so borrow the scanned row's preview. */
export function withAiVaultHistoryPreviews(
  hitSessions: AiVaultSession[],
  history: readonly AiVaultSession[]
): AiVaultSession[] {
  if (hitSessions.length === 0 || history.length === 0) {
    return hitSessions
  }
  // Relay hits are redacted of their transcript path, so join on host, agent and session id; skip ambiguous ones.
  const historyByIdentity = new Map<string, AiVaultSession | null>()
  for (const session of history) {
    const key = previewIdentity(session)
    historyByIdentity.set(key, historyByIdentity.has(key) ? null : session)
  }
  return hitSessions.map((hitSession) => {
    const row = historyByIdentity.get(previewIdentity(hitSession))
    return row && hitSession.previewMessages.length === 0
      ? {
          ...hitSession,
          previewMessages: row.previewMessages,
          ...(row.previewMessagesTruncated ? { previewMessagesTruncated: true } : {}),
          ...(row.lastUserPrompt !== undefined ? { lastUserPrompt: row.lastUserPrompt } : {}),
          ...(row.firstUserPrompt !== undefined ? { firstUserPrompt: row.firstUserPrompt } : {})
        }
      : hitSession
  })
}

function previewIdentity(
  session: Pick<AiVaultSession, 'executionHostId' | 'agent' | 'sessionId'>
): string {
  return JSON.stringify([session.executionHostId, session.agent, session.sessionId])
}

export function canResumeAiVaultSearchHit(hit: AiVaultSearchHit): boolean {
  return (
    hit.structuredSession !== undefined ||
    (hit.source.presence === 'present' && hit.resumeCommand !== undefined)
  )
}

export function hasAiVaultSearchHitPath(hit: AiVaultSearchHit): boolean {
  return hit.source.presence === 'present' && hit.source.filePath !== undefined
}
