import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { HistoryAccountCatalogs } from './history-account-context'

export function groupHistoryContinuations(
  sessions: readonly AiVaultSession[],
  catalogs: HistoryAccountCatalogs,
  include?: (session: AiVaultSession) => boolean
): AiVaultSession[] {
  const seen = new Set<string>()
  const loaded = new Map(
    sessions.map((session) => [
      JSON.stringify([session.executionHostId, session.agent, session.sessionId]),
      session
    ])
  )
  return sessions.flatMap((session) => {
    const entries = catalogs[session.executionHostId]?.continuations ?? []
    const record = entries.find(
      (entry) => entry.provider === session.agent && entry.sessionId === session.sessionId
    )
    if (!record || session.structuredSession) {
      return !include || include(session) ? [session] : []
    }
    const key = JSON.stringify([session.executionHostId, session.agent, record.rootSessionId])
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    const versions = entries
      .filter(
        (entry) => entry.provider === session.agent && entry.rootSessionId === record.rootSessionId
      )
      .sort((a, b) => b.openedAt - a.openedAt)
    const candidates = versions.map((version) => {
      const stored = loaded.get(
        JSON.stringify([session.executionHostId, session.agent, version.sessionId])
      )
      return {
        ...(stored ?? session),
        sessionId: version.sessionId,
        filePath: version.filePath,
        codexHome: session.agent === 'codex' ? version.home : null,
        accountHome: {
          variable:
            session.agent === 'codex' ? ('CODEX_HOME' as const) : ('CLAUDE_CONFIG_DIR' as const),
          path: version.home
        },
        continuationVersions: versions
      }
    })
    const selected = include ? candidates.find(include) : candidates[0]
    return selected ? [selected] : []
  })
}
