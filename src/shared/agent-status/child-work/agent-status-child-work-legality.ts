import type {
  AgentChildWorkInput,
  AgentChildWorkKind,
  AgentChildWorkMembership,
  AgentChildWorkState
} from './agent-status-child-work'

/** A child says what it is doing only while it is live and doing it. */
export function agentChildWorkAllowsOperation(
  membership: AgentChildWorkMembership,
  state: AgentChildWorkState
): boolean {
  return (
    membership === 'live' && (state === 'working' || state === 'waiting' || state === 'blocked')
  )
}

/** Only a shell or a monitor stores `monitoring`; an agent's is derived from the work it owns. */
function storesMonitoring(kind: AgentChildWorkKind): boolean {
  return kind === 'command' || kind === 'monitor'
}

/** The membership x state matrix every record satisfies: live work has no outcome and is not
 *  `done`; settled work is `done` with an outcome and the host time it settled. */
export function isAgentChildWorkLifecycleLegal(
  record: Pick<
    AgentChildWorkInput,
    | 'kind'
    | 'state'
    | 'membership'
    | 'outcome'
    | 'settledAt'
    | 'operation'
    | 'firstObservedAt'
    | 'observedAt'
  >
): boolean {
  if (record.operation && !agentChildWorkAllowsOperation(record.membership, record.state)) {
    return false
  }
  if (record.membership === 'live') {
    return (
      record.state !== 'done' &&
      (record.state !== 'monitoring' || storesMonitoring(record.kind)) &&
      record.outcome === undefined &&
      record.settledAt === undefined
    )
  }
  return (
    record.state === 'done' &&
    record.outcome !== undefined &&
    record.settledAt !== undefined &&
    record.settledAt >= record.firstObservedAt &&
    record.settledAt <= record.observedAt
  )
}
