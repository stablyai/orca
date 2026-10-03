import type { AgentProcessPresence } from './agent-process-presence'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

function isEndedIdentifiedOwner(presence: AgentProcessPresence | undefined): boolean {
  return presence?.process !== undefined && presence.ended === true
}

/** A live identified owner decides its own pane; undefined leaves the pane to legacy signals. */
export function selectLiveOwnerAgent(presence?: AgentProcessPresence): TuiAgent | undefined {
  if (!presence?.process || presence.ended) {
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

/** A title naming the ended owner is that owner's history, not evidence of an agent. */
export function withoutEndedOwnerTitle<T extends string | null>(
  title: T,
  presence: AgentProcessPresence | undefined
): T | '' {
  return title &&
    isEndedIdentifiedOwner(presence) &&
    resolveExplicitTerminalTitleAgentType(title) === presence?.agent
    ? ''
    : title
}

export type PaneEvidenceSignals = {
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
  if (!isEndedIdentifiedOwner(presence)) {
    return args
  }
  return {
    ...args,
    title: withoutEndedOwnerTitle(args.title, presence),
    hookAgent: paneEvidenceAgent(presence, args.hookAgent),
    focusedCompletedHookAgent: paneEvidenceAgent(presence, args.focusedCompletedHookAgent),
    processAgent: paneEvidenceAgent(presence, args.processAgent),
    sleepingSessionAgent: paneEvidenceAgent(presence, args.sleepingSessionAgent),
    launchAgent: paneEvidenceAgent(presence, args.launchAgent) ?? undefined
  }
}
