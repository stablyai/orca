import type { TuiAgent } from './tui-agent'

/**
 * One place that answers "which agent is in this pane".
 *
 * Today four ladders answer it independently — the tab icon, the open-tab/search occupant, the
 * sidebar title rows, and the sidebar hook-row fallback — and they disagree. Two of them consult
 * the terminal title before the launch record, so a string Orca parsed outranks a fact Orca owns.
 *
 * Two rules make this resolvable where reordering alone could not:
 *
 * 1. Evidence is ranked by how directly it observes the process, and a display title is last.
 * 2. Every observation carries the `runId` of the agent run it belongs to. Evidence from a run
 *    that has since been replaced is INELIGIBLE rather than merely outranked.
 *
 * Rule 2 is what separates two situations that are otherwise identical. A completed hook naming
 * A plus a title naming B is either a bug (the hook is right, the title is stale) or a legitimate
 * reclaim (the pane was reused and B really is there). Same signals, opposite answers. With run
 * ids they are different facts: in the bug both belong to the current run, and in the reclaim the
 * hook belongs to a previous one.
 *
 * A run is advanced only on positive evidence that a new agent started in the pane — an accepted
 * launch, a recognized command at a shell prompt, a host-confirmed foreground change, a new
 * provider session. Never by a title changing, and never by transport loss.
 */
export const PANE_AGENT_EVIDENCE_SOURCES = [
  /** A live provider hook for a turn in progress. The agent is running and said so. */
  'live-hook',
  /** The pane's foreground process, as read on the execution host. */
  'process',
  /** Orca launched, resumed, or accepted a command for this agent. A fact Orca owns. */
  'launch',
  /** A provider hook from a turn that finished. Still authoritative about identity. */
  'completed-hook',
  /** A sleeping session record restored for this pane. */
  'sleeping-session',
  /** Another pane in the same tab. Tab-level surfaces only; never pane-scoped routing. */
  'sibling',
  /** Parsed from the terminal title. A decoration channel; anyone can type an agent's name. */
  'title'
] as const
export type PaneAgentEvidenceSource = (typeof PANE_AGENT_EVIDENCE_SOURCES)[number]

/** Authority order, strongest first. Position here is the ONLY place precedence is expressed. */
const SOURCE_RANK: readonly PaneAgentEvidenceSource[] = PANE_AGENT_EVIDENCE_SOURCES

/**
 * Which agent run a piece of evidence belongs to.
 *
 * Why the authority and not a bare number: `incarnation` is only a total order WITHIN one
 * `authorityId` (see agent-status-observation.ts). The id is regenerated per authority instance,
 * so a restarted main, a second machine, and a renderer that parsed bytes itself each count from
 * their own floor. Comparing bare numbers across them silently equates unrelated runs — a
 * restarted host reporting `incarnation: 1` would match a live run 1 from before the restart.
 *
 * Runs from different authorities are INCOMPARABLE, not different.
 */
export type PaneAgentRunKey = {
  authorityId: string
  incarnation: number
}

export type PaneAgentEvidence<A extends string = TuiAgent> = {
  source: PaneAgentEvidenceSource
  agent: A
  /**
   * The agent run this evidence describes. Evidence proven to belong to a SUPERSEDED run is
   * ineligible. Undefined means unknown — from an old peer that does not publish run keys, or an
   * ingress not yet stamped — and is treated as eligible, so a missing field never blanks a row.
   */
  run?: PaneAgentRunKey
}

export type PaneAgentIdentityInput<A extends string = TuiAgent> = {
  evidence: readonly PaneAgentEvidence<A>[]
  /** The pane's current run. Undefined disables run filtering entirely (old peer, mixed version). */
  currentRun?: PaneAgentRunKey
  /**
   * Refuse to answer from evidence weaker than this rank. Consumers that AUTHORIZE AN ACTION —
   * message routing, mailbox delivery, agent-scoped timers — pass `'launch'` so a parsed title or
   * a neighbouring pane can never name the target of a write. Display surfaces omit it.
   */
  minimumSource?: PaneAgentEvidenceSource
  /**
   * Pane-scoped consumers must not inherit another pane's agent. Sibling evidence is dropped
   * unless the caller is a tab-level surface that opted in.
   */
  allowSibling?: boolean
}

export type PaneAgentIdentity<A extends string = TuiAgent> = {
  agent: A | null
  /** Which class of evidence decided it. Null when nothing eligible remained. */
  source: PaneAgentEvidenceSource | null
  /** Set when two equally-ranked sources disagreed, so a caller can tell "nothing" from "conflict". */
  ambiguousAt?: PaneAgentEvidenceSource
  /** Evidence discarded because it belongs to a superseded run. Surfaced for diagnostics. */
  supersededSources: readonly PaneAgentEvidenceSource[]
}

/**
 * Resolves one pane's agent from ranked evidence.
 *
 * Generic over the agent vocabulary: the sidebar speaks the widened `AgentType` and the tab speaks
 * the strict `TuiAgent`. Ranking evidence does not depend on which, and a cast at that boundary
 * would only hide the mismatch.
 *
 * Returns null rather than guessing. A pane with no eligible evidence shows no agent, which is
 * recoverable; showing the wrong agent is not, and at the action surfaces (orchestration routing,
 * mailbox delivery, prompt-cache timers) it is a misdelivery rather than a cosmetic slip.
 */
export function resolvePaneAgentIdentity<A extends string = TuiAgent>(
  input: PaneAgentIdentityInput<A>
): PaneAgentIdentity<A> {
  const superseded: PaneAgentEvidenceSource[] = []
  const floor = input.minimumSource
    ? SOURCE_RANK.indexOf(input.minimumSource)
    : Number.MAX_SAFE_INTEGER

  const eligible = input.evidence.filter((item) => {
    if (item.source === 'sibling' && input.allowSibling !== true) {
      return false
    }
    // Why the floor: an action consumer must not be able to act on a title, at any rank. Dropping
    // the evidence entirely rather than ranking it lower makes misuse impossible rather than
    // unlikely — a caller cannot accidentally consult it by reordering.
    if (SOURCE_RANK.indexOf(item.source) > floor) {
      return false
    }
    if (input.currentRun === undefined || item.run === undefined) {
      // Why eligible: absence means "this peer does not publish run keys", not "this is stale".
      // Treating unknown as superseded would blank every row from an older host.
      return true
    }
    if (item.run.authorityId !== input.currentRun.authorityId) {
      // Why eligible and NOT superseded: runs from different authorities are incomparable, not
      // older. A restarted main counts from its own floor, so `incarnation` alone would falsely
      // equate unrelated runs. Incomparable evidence is treated as unknown, like an absent key.
      return true
    }
    if (item.run.incarnation === input.currentRun.incarnation) {
      return true
    }
    superseded.push(item.source)
    return false
  })

  for (const source of SOURCE_RANK) {
    const matches = eligible.filter((item) => item.source === source)
    if (matches.length === 0) {
      continue
    }
    const agents = new Set(matches.map((item) => item.agent))
    if (agents.size > 1) {
      // Why null and not the first: two observations of the same class naming different agents is
      // a genuine conflict, and picking one would make the answer depend on array order — the very
      // property this resolver exists to remove. Fall through to nothing rather than guess.
      return { agent: null, source: null, ambiguousAt: source, supersededSources: superseded }
    }
    return { agent: matches[0].agent, source, supersededSources: superseded }
  }
  return { agent: null, source: null, supersededSources: superseded }
}
