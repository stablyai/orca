import { resolveCanonicalPaneAgentEvidence } from './pane-agent-identity-adapter'
import type { PaneAgentEvidenceSource } from './pane-agent-evidence-sources'
import type { TerminalAgent } from './terminal-agent'

export { PANE_AGENT_EVIDENCE_SOURCES } from './pane-agent-evidence-sources'
export type { PaneAgentEvidenceSource } from './pane-agent-evidence-sources'

/** Rank identity by direct process evidence, with titles last. Discard superseded runs rather than merely ranking them lower:
 * completed-hook A/title B means stale title in the current run, but legitimate reclaim when A belongs to a replaced run.
 * Advance runs only on positive start evidence (accepted launch/command, host-confirmed foreground change or provider session),
 * never title changes or transport loss. */
/** Incarnations are ordered only within one authorityId. Authorities restart/reseed independently; different authorities
 * are incomparable, never proof of a superseded run (agent-status-observation.ts). */
export type PaneAgentRunKey = {
  authorityId: string
  incarnation: number
}

export type PaneAgentEvidence<A extends string = TerminalAgent> = {
  source: PaneAgentEvidenceSource
  agent: A
  /** Discard proven superseded runs; missing keys from old peers or unstamped ingress stay eligible to avoid blank rows. */
  run?: PaneAgentRunKey
}

export type PaneAgentIdentityInput<A extends string = TerminalAgent> = {
  evidence: readonly PaneAgentEvidence<A>[]
  /** The pane's current run. Undefined disables run filtering entirely (old peer, mixed version). */
  currentRun?: PaneAgentRunKey
  /** Write-routing consumers set launch as the minimum so titles/sibling panes cannot choose mutation targets; displays may omit it. */
  minimumSource?: PaneAgentEvidenceSource
  /** Pane-scoped consumers cannot inherit sibling identity; only tab-level surfaces may opt in. */
  allowSibling?: boolean
}

export type PaneAgentIdentity<A extends string = TerminalAgent> = {
  agent: A | null
  /** Which class of evidence decided it. Null when nothing eligible remained. */
  source: PaneAgentEvidenceSource | null
  /** Set when two equally-ranked sources disagreed, so a caller can tell "nothing" from "conflict". */
  ambiguousAt?: PaneAgentEvidenceSource
  /** Evidence discarded because it belongs to a superseded run. Surfaced for diagnostics. */
  supersededSources: readonly PaneAgentEvidenceSource[]
}

/** Generic agent vocabularies share ranking without casts. Return null instead of guessing: incorrect identity can misroute
 * mail, orchestration or prompt-cache actions, not just display the wrong icon. */
export function resolvePaneAgentIdentity<A extends string = TerminalAgent>(
  input: PaneAgentIdentityInput<A>
): PaneAgentIdentity<A> {
  return resolveCanonicalPaneAgentEvidence(input)
}
