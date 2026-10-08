import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { startsNewAgentRun } from './agent-hook-listener/provider-event-routing'
import {
  isSameAgentProcess,
  MAX_OWNER_HELD_SESSIONS,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from './agent-process-presence'
import { isFreshNonDoneAgentStatus } from './agent-status-freshness'
import { getTuiAgentHookAgent } from './tui-agent-hook-agent'

/** `write` stores the event; `skip` leaves the row unchanged. `probe` is an owner process another
 *  producer cast doubt on; on `skip` it also means the event is held until that owner is gone. */
export type HookPresenceTransition =
  | { kind: 'write'; event: AgentHookEventPayload; probe?: AgentProcessIdentity }
  | { kind: 'skip'; probe?: AgentProcessIdentity }

type HookProducer = {
  agent: string | undefined
  session?: string
  process?: AgentProcessIdentity
  /** Sessions of other agent types this producer runs inside (own-type markers prove nothing). */
  nestedIn: string[]
}

/** The pane's owner. An ended owner, or an identity-only row (a resume remnant, a Pi session
 *  announcement), holds no pane. */
export function currentOwner(
  row: AgentHookEventPayload | undefined
): AgentProcessPresence | undefined {
  return row?.agentPresence && !row.agentPresence.ended && !row.providerSessionOnly
    ? row.agentPresence
    : undefined
}

/** The owner a launched agent command's end ends: the pane's owner when it is the launched agent.
 *  Each execution host (main locally, the relay over SSH) applies it to the panes it runs. */
export function ownerEndedByLaunch(
  row: AgentHookEventPayload | undefined,
  launchAgent: string | null | undefined
): AgentProcessPresence | undefined {
  const owner = currentOwner(row)
  return owner && launchAgent && owner.agent === getTuiAgentHookAgent(launchAgent)
    ? owner
    : undefined
}

function readHookProducer(incoming: AgentHookEventPayload): HookProducer {
  const agent = incoming.agentPresence?.agent ?? incoming.payload.agentType
  return {
    agent: agent && agent !== 'unknown' ? agent : undefined,
    session: incoming.providerSession?.id,
    process: incoming.agentPresence?.process,
    nestedIn: (incoming.nestedIn ?? [])
      .filter((entry) => entry.agent !== agent)
      .map((entry) => entry.session)
  }
}

function ownerSessions(owner: AgentProcessPresence): string[] {
  return owner.session ? [owner.session, ...(owner.heldSessions ?? [])] : (owner.heldSessions ?? [])
}

function sameProcess(
  a: AgentProcessIdentity | undefined,
  b: AgentProcessIdentity | undefined
): boolean {
  return a !== undefined && b !== undefined && isSameAgentProcess(a, b)
}

function otherProcess(
  a: AgentProcessIdentity | undefined,
  b: AgentProcessIdentity | undefined
): boolean {
  return a !== undefined && b !== undefined && !isSameAgentProcess(a, b)
}

// Why: only an owner this host cannot check falls back to freshness; a restored one never blocks.
function isOwnerReleased(
  owner: AgentProcessPresence,
  row: AgentHookEventPayload,
  rowUpdatedAt: number | undefined,
  now: number,
  checkable = true
): boolean {
  return (
    row.restoredUnconfirmed === true ||
    ((!checkable || owner.process === undefined) &&
      !isFreshNonDoneAgentStatus({ state: row.payload.state, updatedAt: rowUpdatedAt ?? 0 }, now))
  )
}

/** An owned row's agent type is its owner's; an event that names no agent never erases it. */
export function withOwnerAgentType(
  event: AgentHookEventPayload,
  owner: AgentProcessPresence
): AgentHookEventPayload {
  const agentType = event.payload.agentType
  return agentType && agentType !== 'unknown'
    ? event
    : { ...event, payload: { ...event.payload, agentType: owner.agent } }
}

/** PLAN rules 1-4, first match wins: proven guests (rule 2) need no liveness check. */
function classifyAgainstOwner(
  producer: HookProducer,
  owner: AgentProcessPresence,
  previous: AgentHookEventPayload,
  rowUpdatedAt: number | undefined,
  now: number
): 'owner' | 'nested' | 'guest' | 'claim' {
  const held = ownerSessions(owner)
  if (
    (producer.session !== undefined && held.includes(producer.session)) ||
    sameProcess(producer.process, owner.process)
  ) {
    return 'owner'
  }
  if (producer.nestedIn.some((session) => held.includes(session))) {
    return 'nested'
  }
  if (producer.agent === undefined || producer.agent === owner.agent) {
    return 'owner'
  }
  return isOwnerReleased(owner, previous, rowUpdatedAt, now) ? 'claim' : 'guest'
}

function withOwnerSession(
  owner: AgentProcessPresence,
  producer: HookProducer
): AgentProcessPresence {
  const session = producer.session
  // Why: a different process of the owner's type, or a producer naming no agent, never rotates it.
  if (
    !session ||
    !producer.agent ||
    session === owner.session ||
    otherProcess(producer.process, owner.process)
  ) {
    return owner
  }
  const heldSessions = ownerSessions(owner)
    .filter((held) => held !== session)
    .slice(0, MAX_OWNER_HELD_SESSIONS)
  return { ...owner, session, ...(heldSessions.length > 0 ? { heldSessions } : {}) }
}

/** The owner's own sparse events (child hooks, a relay that restarted) keep its model and session;
 *  a restarted process of the same type starts clean. */
function carryOwnerFields(
  event: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload {
  // Why: a row with no owner record still carries (older relays' envelopes send no agentPresence).
  if (
    !previous ||
    previous.providerSessionOnly ||
    previous.agentPresence?.ended ||
    previous.payload.agentType !== event.payload.agentType ||
    otherProcess(event.agentPresence?.process, previous.agentPresence?.process)
  ) {
    return event
  }
  const providerSession = event.providerSession ?? previous.providerSession
  const model = event.payload.model ?? previous.payload.model
  if (providerSession === event.providerSession && model === event.payload.model) {
    return event
  }
  return {
    ...event,
    ...(providerSession ? { providerSession } : {}),
    payload: model ? { ...event.payload, model } : event.payload
  }
}

/** A pane has one owning agent. Only the owner's hook events write the row; a different agent's are
 *  guests until the owner is proven gone. Shared by main (local rows) and the relay (remote rows). */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  rowUpdatedAt: number | undefined,
  now = Date.now()
): HookPresenceTransition {
  const { nestedIn: _nestedIn, ...event } = incoming
  const owner = currentOwner(previous)
  const producer = readHookProducer(incoming)
  // Why: only an admitted exit is marked ended (Claude's process-ending SessionEnd, or a host-proved
  // exit); other agents' SessionEnd hooks are ordinary status updates.
  const exit = incoming.agentPresence?.ended === true
  if (owner && previous) {
    const verdict = classifyAgainstOwner(producer, owner, previous, rowUpdatedAt, now)
    if (verdict === 'nested') {
      return { kind: 'skip' }
    }
    if (verdict === 'guest') {
      return exit || !owner.process ? { kind: 'skip' } : { kind: 'skip', probe: owner.process }
    }
    if (verdict === 'owner' && exit) {
      return sameProcess(owner.process, producer.process)
        ? {
            kind: 'write',
            event: { ...event, payload: previous.payload, agentPresence: { ...owner, ended: true } }
          }
        : { kind: 'skip' }
    }
    if (verdict === 'owner') {
      const probe = otherProcess(producer.process, owner.process) ? owner.process : undefined
      return {
        kind: 'write',
        event: {
          ...carryOwnerFields(withOwnerAgentType(event, owner), previous),
          agentPresence: withOwnerSession(owner, producer)
        },
        ...(probe ? { probe } : {})
      }
    }
  }
  const ended = previous?.agentPresence?.ended ? previous.agentPresence : undefined
  // Why: an ended owner's late hooks never revive it. Without process proof on either side, only an
  // event that starts a new run tells a new run of its type from a late hook of the ended one.
  const lateFromEnded =
    sameProcess(ended?.process, producer.process) ||
    (ended !== undefined &&
      ended.agent === producer.agent &&
      !ended.process &&
      !producer.process &&
      !startsNewAgentRun({
        source: incoming.source,
        hookEventName: incoming.hookEventName,
        hasExplicitPrompt: incoming.hasExplicitPrompt
      }))
  // Why: a producer nested inside another agent's session never takes an ownerless pane, so a
  // restart that brings both back cannot hand the pane to the nested one.
  if (exit || lateFromEnded || producer.nestedIn.length > 0) {
    return { kind: 'skip' }
  }
  if (!producer.agent) {
    return { kind: 'write', event: { ...event, agentPresence: undefined } }
  }
  return {
    kind: 'write',
    event: {
      ...event,
      agentPresence: {
        agent: producer.agent,
        ...(producer.process ? { process: producer.process } : {}),
        ...(producer.session ? { session: producer.session } : {})
      }
    }
  }
}

/** Main adopts a relayed row as its relay built it; host restatements (cancel inference, expiry)
 *  carry no owner, so the relayed one stands. */
export function adoptRelayedRow(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload {
  const owner = incoming.agentPresence ?? currentOwner(previous)
  const adopted = { ...incoming, agentPresence: owner }
  return carryOwnerFields(
    owner && !owner.ended ? withOwnerAgentType(adopted, owner) : adopted,
    previous
  )
}

export type TerminalSignalVerdict =
  | { kind: 'yield'; probe?: AgentProcessIdentity }
  | { kind: 'write'; owner?: AgentProcessPresence }

/** Terminal signals (OSC, title, process-derived) never claim. One naming another agent than a held
 *  owner yields: the row stays and the owner is doubted. Otherwise it writes under the owner when it
 *  names it (or no agent), and ownerless once the owner was released. */
export function classifyTerminalSignal(
  previous: (AgentHookEventPayload & { receivedAt: number }) | undefined,
  agentType: string | undefined,
  ownerCheckable: boolean,
  now = Date.now()
): TerminalSignalVerdict {
  const owner = currentOwner(previous)
  if (!owner || !previous) {
    return { kind: 'write' }
  }
  if (!agentType || agentType === 'unknown' || agentType === owner.agent) {
    return { kind: 'write', owner }
  }
  if (isOwnerReleased(owner, previous, previous.receivedAt, now, ownerCheckable)) {
    return { kind: 'write' }
  }
  return ownerCheckable && owner.process
    ? { kind: 'yield', probe: owner.process }
    : { kind: 'yield' }
}
