import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { parsePaneKey } from '../../../shared/stable-pane-id'

/** Old structured projections persisted their desktop id as if a terminal could resume it. */
export function isStructuredAgentSyntheticSleepingRecord(
  record: SleepingAgentSessionRecord
): boolean {
  const pane = parsePaneKey(record.paneKey)
  return (
    pane !== null &&
    record.providerSession.key === 'session_id' &&
    structuredAgentSessionTabId(record.providerSession.id) === pane.tabId
  )
}
