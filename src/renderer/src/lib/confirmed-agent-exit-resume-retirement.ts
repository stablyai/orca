import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { parseLegacyNumericPaneKey } from '../../../shared/stable-pane-id'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'

type ResumeRetirementStore = {
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  clearSleepingAgentSessionsByPaneKey: (paneKeys: readonly string[]) => void
}

export function findSleepingAgentResumeRecordForPane(
  records: Record<string, SleepingAgentSessionRecord>,
  identity: { paneKey: string; tabId: string; worktreeId: string; paneId?: string | number }
): { paneKey: string; record: SleepingAgentSessionRecord } | null {
  const stableRecord = records[identity.paneKey]
  if (stableRecord) {
    return { paneKey: identity.paneKey, record: stableRecord }
  }
  const legacyMatches = Object.entries(records).filter(([paneKey, record]) => {
    const legacy = parseLegacyNumericPaneKey(paneKey)
    return (
      legacy?.tabId === identity.tabId &&
      record.worktreeId === identity.worktreeId &&
      (!record.tabId || record.tabId === identity.tabId)
    )
  })
  const exactLegacyMatch = legacyMatches.find(([paneKey]) => {
    const legacy = parseLegacyNumericPaneKey(paneKey)
    return identity.paneId !== undefined && legacy?.numericPaneId === String(identity.paneId)
  })
  const providerSessionKeys = new Set(
    legacyMatches.map(([, record]) => getProviderSessionClaimKey(record))
  )
  const selectedLegacyMatch =
    exactLegacyMatch ??
    (providerSessionKeys.size === 1
      ? legacyMatches
          .slice()
          .sort(([, a], [, b]) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)[0]
      : undefined)
  return selectedLegacyMatch
    ? { paneKey: selectedLegacyMatch[0], record: selectedLegacyMatch[1] }
    : null
}

export function retireConfirmedAgentExitResumeRecord(
  state: ResumeRetirementStore,
  consumed: { paneKey: string; record: SleepingAgentSessionRecord }
): void {
  const paneKeys = [consumed.paneKey]
  for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey)) {
    if (
      paneKey !== consumed.paneKey &&
      record.worktreeId === consumed.record.worktreeId &&
      record.agent === consumed.record.agent &&
      agentProviderSessionsEqual(
        record.agent,
        record.providerSession,
        consumed.record.providerSession
      )
    ) {
      paneKeys.push(paneKey)
    }
  }
  state.clearSleepingAgentSessionsByPaneKey(paneKeys)
}

export function retireConfirmedAgentExitResumeAuthority(
  state: ResumeRetirementStore,
  paneKey: string,
  legacyIdentity?: { tabId: string; worktreeId: string; paneId?: string | number }
): void {
  const consumed = legacyIdentity
    ? findSleepingAgentResumeRecordForPane(state.sleepingAgentSessionsByPaneKey, {
        paneKey,
        ...legacyIdentity
      })
    : state.sleepingAgentSessionsByPaneKey[paneKey]
      ? { paneKey, record: state.sleepingAgentSessionsByPaneKey[paneKey] }
      : null
  if (!consumed) {
    return
  }
  retireConfirmedAgentExitResumeRecord(state, consumed)
}
