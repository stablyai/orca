// A sleeping record a pre-stable-id build keyed by the pane's number (`tab:2`) instead of its leaf.
// Shipped builds still write them for agents in panes spawned before the stable-id migration.

import type { SleepingAgentSessionRecord } from './agent-session-resume'
import { parseLegacyNumericPaneKey } from './stable-pane-id'

/** One provider conversation in a workspace; aliases of one conversation share it. */
export function getProviderSessionClaimKey(record: SleepingAgentSessionRecord): string {
  const base = `${record.worktreeId}\0${record.agent}\0${record.providerSession.key}\0${record.providerSession.id}`
  return record.agent === 'pi' || record.agent === 'prime-agent'
    ? `${base}\0${record.providerSession.transcriptPath ?? ''}`
    : base
}

/**
 * The tab's numbered record for the pane: the one with its number, else the oldest capture when
 * every numbered record in the tab names one conversation. `aliases`: every numbered key of the tab
 * in this workspace. A pane whose number is unknown (main) matches only by the one-conversation rule.
 */
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
  // Why: duplicate legacy aliases can point at one provider session; consume
  // the oldest capture as canonical and clear its aliases after resume.
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
