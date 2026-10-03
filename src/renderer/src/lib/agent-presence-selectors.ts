import { shallow } from 'zustand/shallow'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { AgentProcessPresence } from '../../../shared/agent-process-presence'
import {
  selectLiveOwnerAgent,
  withoutEndedOwnerEvidence,
  type PaneEvidenceSignals
} from '../../../shared/ended-agent-owner-evidence'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentPresenceByPaneKey, AgentPresenceRecord } from '@/store/slices/agent-presence'

export {
  evidenceAfterEndedAgent,
  paneEvidenceAgent,
  paneEvidenceCounts,
  selectLiveOwnerAgent,
  withoutEndedOwnerEvidence
} from '../../../shared/ended-agent-owner-evidence'

const EMPTY_PRESENCE: AgentPresenceByPaneKey = Object.freeze({})
let previousPresence: AgentPresenceByPaneKey | undefined
let byTab = new Map<string, AgentPresenceByPaneKey>()

/** One index per host publication, shared by mounted panes and activity readers. */
export function selectAgentPresencesForTab(
  presence: AgentPresenceByPaneKey | undefined,
  tabId: string
): AgentPresenceByPaneKey {
  if (presence !== previousPresence) {
    const next = new Map<string, Record<string, AgentPresenceRecord>>()
    for (const [paneKey, record] of Object.entries(presence ?? {})) {
      const pane = parsePaneKey(paneKey)
      if (!pane) {
        continue
      }
      const bucket = next.get(pane.tabId) ?? {}
      bucket[paneKey] = record
      next.set(pane.tabId, bucket)
    }
    const stabilized = new Map<string, AgentPresenceByPaneKey>()
    for (const [id, bucket] of next) {
      const previous = byTab.get(id)
      stabilized.set(id, previous && shallow(previous, bucket) ? previous : bucket)
    }
    byTab = stabilized
    previousPresence = presence
  }
  return byTab.get(tabId) ?? EMPTY_PRESENCE
}

/** The pane the tab shows; a tab whose layout has not hydrated can still name its only record. */
export function selectFocusedPanePresence(
  presence: AgentPresenceByPaneKey | undefined,
  tabId: string,
  focusedPaneKey: string | null
): AgentProcessPresence | undefined {
  const records = selectAgentPresencesForTab(presence, tabId)
  if (focusedPaneKey) {
    return records[focusedPaneKey]?.presence
  }
  const only = Object.values(records)
  return only.length === 1 ? only[0].presence : undefined
}

/** One per-pane rule for every identity reader: live owner, else legacy minus ended-owner evidence. */
export function resolvePaneAgentWithPresence<T extends PaneEvidenceSignals>(
  presence: AgentProcessPresence | undefined,
  args: T,
  resolveLegacy: (args: T) => TuiAgent | null
): TuiAgent | null {
  return selectLiveOwnerAgent(presence) ?? resolveLegacy(withoutEndedOwnerEvidence(args, presence))
}

/** Launch intent ends with its owner's positive exit; unidentified panes keep the legacy guess. */
export function resolveLaunchExitWithPresence<T extends Omit<PaneEvidenceSignals, 'launchAgent'>>(
  presence: AgentProcessPresence | undefined,
  launchAgent: TuiAgent | undefined,
  args: T,
  resolveLegacy: (args: T) => boolean
): boolean {
  if (selectLiveOwnerAgent(presence)) {
    return false
  }
  if (presence?.process && presence.ended && launchAgent === presence.agent) {
    return true
  }
  return resolveLegacy(withoutEndedOwnerEvidence(args, presence))
}
