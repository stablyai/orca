// Pre-stable-ID panes still persist numbered keys (tab:2) until their old panes retire.

import type { SleepingAgentSessionRecord } from './agent-session-resume'
import { parseLegacyNumericPaneKey } from './stable-pane-id'

/** One provider conversation in a workspace; aliases of one conversation share it. */
export function getProviderSessionClaimKey(record: SleepingAgentSessionRecord): string {
  const base = `${record.worktreeId}\0${record.agent}\0${record.providerSession.key}\0${record.providerSession.id}`
  return record.agent === 'pi' || record.agent === 'prime-agent'
    ? `${base}\0${record.providerSession.transcriptPath ?? ''}`
    : base
}

/** Prefer the pane’s numbered record, otherwise the oldest if all numbered records name one conversation.
 * Unknown pane numbers require that one-conversation fallback; aliases contains every numbered key in the workspace/tab. */
export function findLegacyNumericSleepingRecord(
  records: Readonly<Record<string, SleepingAgentSessionRecord>>,
  pane: { tabId: string; numericPaneId?: string },
  inWorkspace: (record: SleepingAgentSessionRecord) => boolean
): { paneKey: string; record: SleepingAgentSessionRecord; aliases: string[] } | null {
  const legacyMatches = Object.entries(records).filter(([paneKey, record]) => {
    const legacy = parseLegacyNumericPaneKey(paneKey)
    return (
      legacy?.tabId === pane.tabId &&
      inWorkspace(record) &&
      (!record.tabId || record.tabId === pane.tabId)
    )
  })
  const exactLegacyMatch =
    pane.numericPaneId === undefined
      ? undefined
      : legacyMatches.find(
          ([paneKey]) => parseLegacyNumericPaneKey(paneKey)?.numericPaneId === pane.numericPaneId
        )
  const providerSessionKeys = new Set(
    legacyMatches.map(([, record]) => getProviderSessionClaimKey(record))
  )
  const oldestLegacyMatch = legacyMatches
    .slice()
    .sort(([, a], [, b]) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)[0]
  // Canonicalize duplicate conversation aliases to the oldest capture; clear all aliases after resume.
  const selected =
    exactLegacyMatch ??
    (providerSessionKeys.size === 1
      ? legacyMatches.length === 1
        ? legacyMatches[0]
        : oldestLegacyMatch
      : null)
  if (!selected) {
    return null
  }
  const [paneKey, record] = selected
  return { paneKey, record, aliases: legacyMatches.map(([key]) => key) }
}
