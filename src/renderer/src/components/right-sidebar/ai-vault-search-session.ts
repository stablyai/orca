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
    subagent: null
  }
}

export function canResumeAiVaultSearchHit(hit: AiVaultSearchHit): boolean {
  return hit.source.presence === 'present' && hit.resumeCommand !== undefined
}

export function hasAiVaultSearchHitPath(hit: AiVaultSearchHit): boolean {
  return hit.source.presence === 'present' && hit.source.filePath !== undefined
}
