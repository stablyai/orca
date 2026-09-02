import type {
  AiVaultSearchEvidence,
  AiVaultSearchHit
} from '../../../../shared/ai-vault-search-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const EPOCH_ISO = new Date(0).toISOString()

export type AiVaultSearchHitSessions = {
  /** Server order preserved: relevance (or newest) already decided the ranking. */
  sessions: AiVaultSession[]
  evidenceBySessionId: Map<string, AiVaultSearchEvidence>
}

/**
 * Hits rendered through the list's own row.
 *
 * A hit that is also in the loaded list reuses that row verbatim, so resume
 * targets, worktree affordances and live state all keep working. Older hits
 * the list never fetched are projected onto the same shape from what the index
 * stored, which is everything the row reads except the conversation preview.
 */
export function aiVaultSearchHitSessions(
  hits: readonly AiVaultSearchHit[],
  listedSessions: readonly AiVaultSession[],
  executionHostId: ExecutionHostId
): AiVaultSearchHitSessions {
  const listedByIdentity = new Map<string, AiVaultSession>()
  for (const session of listedSessions) {
    listedByIdentity.set(hitIdentity(session), session)
  }
  const sessions: AiVaultSession[] = []
  const evidenceBySessionId = new Map<string, AiVaultSearchEvidence>()
  for (const hit of hits) {
    const session =
      listedByIdentity.get(hitIdentity(hit)) ?? projectHitSession(hit, executionHostId)
    // A transcript can match twice across tiers; the row key must stay unique.
    if (evidenceBySessionId.has(session.id)) {
      continue
    }
    evidenceBySessionId.set(session.id, hit.evidence)
    sessions.push(session)
  }
  return { sessions, evidenceBySessionId }
}

function hitIdentity(value: Pick<AiVaultSearchHit, 'agent' | 'sessionId' | 'filePath'>): string {
  return `${value.agent}:${value.sessionId}:${value.filePath}`
}

function projectHitSession(
  hit: AiVaultSearchHit,
  executionHostId: ExecutionHostId
): AiVaultSession {
  return {
    id: `${executionHostId}:${hit.agent}:${hit.sessionId}:${hit.filePath}`,
    executionHostId,
    agent: hit.agent,
    sessionId: hit.sessionId,
    title: hit.title,
    cwd: hit.cwd,
    branch: hit.branch,
    model: null,
    filePath: hit.filePath,
    codexHome: hit.codexHome,
    createdAt: null,
    updatedAt: hit.updatedAt,
    modifiedAt: hit.updatedAt ?? EPOCH_ISO,
    messageCount: hit.messageCount,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: hit.resumeCommand,
    subagent: null
  }
}
