// Derive status from current runtime facts at publish. Losing SSH contact never proves process exit (§1.1).

import type { PaneOutcome } from './workspace-layout-pane-outcomes'

export type PaneStatus =
  | 'starting'
  | 'waiting_for_host'
  | 'running'
  | 'exited'
  | 'sleeping'
  | 'restorable'
  | 'failed'
  | 'unverifiable'

/** awaiting: the runtime cannot yet start there, including unconverted SSH partitions; lost: contact with the terminal’s host ended. */
export type PaneHostReach = 'reachable' | 'awaiting' | 'lost'

/** What the PTY registry says of the pane's bound terminal; null when unbound or not registered. */
export type PaneTerminalFact = 'live' | 'exited' | 'unverifiable' | null

export type PaneStatusFacts = {
  starting: boolean
  /** Last outcome from the holder’s PaneOutcomes. */
  lastOutcome: PaneOutcome | null
  sleeping: boolean
  terminal: PaneTerminalFact
  host: PaneHostReach
}

/** First match wins: outcomes and sleeping records outrank host reachability. A bound terminal unknown to the registry is restorable on view. */
export function derivePaneStatus(facts: PaneStatusFacts): PaneStatus {
  if (facts.starting) {
    return 'starting'
  }
  if (facts.lastOutcome) {
    return facts.lastOutcome
  }
  if (facts.sleeping) {
    return 'sleeping'
  }
  if (facts.host === 'awaiting' || (facts.host === 'lost' && facts.terminal === null)) {
    return 'waiting_for_host'
  }
  // A terminal on a host out of contact may still run; only an exit proven before stays `exited`.
  if (facts.host === 'lost' && facts.terminal !== 'exited') {
    return 'unverifiable'
  }
  switch (facts.terminal) {
    case 'live':
      return 'running'
    case 'exited':
      return 'exited'
    case 'unverifiable':
      return 'unverifiable'
    case null:
      return 'restorable'
  }
}
