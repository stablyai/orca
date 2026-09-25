import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'

// Why a frozen literal: only pre-restructure persisted records carry it; no live chat tab id derives from a session.
const LEGACY_STRUCTURED_CHAT_TAB_ID_PREFIX = 'structured-agent-session-'

/** Old structured projections persisted their desktop id as if a terminal could resume it. */
export function isLegacyStructuredAgentSyntheticSleepingRecord(
  record: SleepingAgentSessionRecord
): boolean {
  const pane = parsePaneKey(record.paneKey)
  return (
    pane !== null &&
    record.providerSession.key === 'session_id' &&
    pane.tabId === `${LEGACY_STRUCTURED_CHAT_TAB_ID_PREFIX}${record.providerSession.id}`
  )
}
