import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { HistoryAccountCatalogs } from './history-account-context'
import {
  historyTranscriptKey,
  historyContinuationRootKey
} from '../../../../../../shared/ai-vault/resume/history-transcript-identity'

export function groupHistoryContinuations(
  sessions: readonly AiVaultSession[],
  catalogs: HistoryAccountCatalogs,
  include?: (session: AiVaultSession) => boolean
): AiVaultSession[] {
  const seen = new Set<string>()
  const loaded = new Map(
    sessions.map((session) => [
      JSON.stringify([
        session.executionHostId,
        historyTranscriptKey(session.agent, session.filePath)
      ]),
      session
    ])
  )
  return sessions.flatMap((session) => {
    const entries = catalogs[session.executionHostId]?.continuations ?? []
    const record = entries.find(
      (entry) =>
        historyTranscriptKey(entry.provider, entry.filePath) ===
        historyTranscriptKey(session.agent, session.filePath)
    )
    if (!record || session.structuredSession) {
      return !include || include(session) ? [session] : []
    }
    const rootKey = historyContinuationRootKey(record, entries)
    const key = JSON.stringify([session.executionHostId, rootKey])
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    const versions = entries
      .filter(
        (entry) =>
          entry.provider === session.agent && historyContinuationRootKey(entry, entries) === rootKey
      )
      .sort((a, b) => b.openedAt - a.openedAt)
    const candidates = versions.flatMap((version) => {
      const stored = loaded.get(
        JSON.stringify([
          session.executionHostId,
          historyTranscriptKey(session.agent, version.filePath)
        ])
      )
      if (!stored) {
        return []
      }
      return [
        {
          ...stored,
          sessionId: version.sessionId,
          filePath: version.filePath,
          codexHome: session.agent === 'codex' ? version.home : null,
          accountHome: {
            variable:
              session.agent === 'codex' ? ('CODEX_HOME' as const) : ('CLAUDE_CONFIG_DIR' as const),
            path: version.home
          },
          continuationVersions: versions,
          resumeCommand: ''
        }
      ]
    })
    const selected = include ? candidates.find(include) : candidates[0]
    return selected ? [selected] : []
  })
}
