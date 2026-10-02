import { shallow } from 'zustand/shallow'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { AgentProcessPresence } from '../../../shared/agent-process-presence'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentPresenceByPaneKey, AgentPresenceRecord } from '@/store/slices/agent-presence'
import { isLegacyUnidentified } from './legacy-unidentified-agent-presence'

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

/** A live identified owner decides its own pane; undefined leaves the pane to legacy signals. */
export function selectLiveOwnerAgent(presence?: AgentProcessPresence): TuiAgent | undefined {
  if (!presence || isLegacyUnidentified(presence)) {
    return undefined
  }
  return isTuiAgent(presence.agent) ? presence.agent : undefined
}

/** After the identified owner exits, only evidence naming a different agent still describes the pane. */
export function paneEvidenceCounts(
  presence: AgentProcessPresence | undefined,
  agent: string | null | undefined
): boolean {
  return countsAfterEndedAgent(endedOwnerAgent(presence), agent)
}

export function paneEvidenceAgent<T extends string>(
  presence: AgentProcessPresence | undefined,
  agent: T | null | undefined
): T | null {
  return evidenceAfterEndedAgent(endedOwnerAgent(presence), agent)
}

/** The same rule when only the exited owner's agent is at hand (the tab strip's projection). */
export function evidenceAfterEndedAgent<T extends string>(
  endedAgent: string | undefined,
  agent: T | null | undefined
): T | null {
  return agent && countsAfterEndedAgent(endedAgent, agent) ? agent : null
}

function endedOwnerAgent(presence: AgentProcessPresence | undefined): string | undefined {
  return presence?.process && presence.ended ? presence.agent : undefined
}

function countsAfterEndedAgent(
  endedAgent: string | undefined,
  agent: string | null | undefined
): boolean {
  return endedAgent === undefined || (Boolean(agent) && agent !== 'unknown' && agent !== endedAgent)
}

type PaneEvidenceSignals = {
  title: string
  hookAgent: TuiAgent | null
  focusedCompletedHookAgent?: TuiAgent | null
  processAgent?: TuiAgent | null
  sleepingSessionAgent?: TuiAgent | null
  launchAgent?: TuiAgent
}

/** The signals a legacy resolver may still read once an ended owner's own evidence is set aside. */
export function withoutEndedOwnerEvidence<T extends PaneEvidenceSignals>(
  args: T,
  presence: AgentProcessPresence | undefined
): T {
  if (!presence?.process || !presence.ended) {
    return args
  }
  const titleAgent = resolveExplicitTerminalTitleAgentType(args.title)
  return {
    ...args,
    title: titleAgent === presence.agent ? '' : args.title,
    hookAgent: paneEvidenceAgent(presence, args.hookAgent),
    focusedCompletedHookAgent: paneEvidenceAgent(presence, args.focusedCompletedHookAgent),
    processAgent: paneEvidenceAgent(presence, args.processAgent),
    sleepingSessionAgent: paneEvidenceAgent(presence, args.sleepingSessionAgent),
    launchAgent: paneEvidenceAgent(presence, args.launchAgent) ?? undefined
  }
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
