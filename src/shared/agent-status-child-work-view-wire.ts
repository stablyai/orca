// How a child-work view crosses a client/host boundary.
//
// Views reach clients from hosts of any version, so they are read permissively: unknown keys are
// ignored and an unknown enum arm degrades to one every reader already handles, never rejecting the
// row (docs/reference/remote-wire-compatibility.md, Rules 1 and 4). The record codec stays
// host-internal; nothing here imports it. Type-only imports keep this loadable in the renderer.

import type {
  AgentChildWorkKind,
  AgentChildWorkMembership,
  AgentChildWorkOperation,
  AgentChildWorkOperationBasis,
  AgentChildWorkOutcome,
  AgentChildWorkState
} from './agent-status-child-work'
import type { AgentChildWorkView } from './agent-status-child-work-view'

const KINDS: readonly AgentChildWorkKind[] = ['agent', 'workflow', 'command', 'monitor', 'unknown']
const STATES: readonly AgentChildWorkState[] = [
  'working',
  'monitoring',
  'waiting',
  'blocked',
  'done',
  'idle',
  'unverifiable'
]
const OUTCOMES: readonly AgentChildWorkOutcome[] = ['succeeded', 'failed', 'cancelled', 'unknown']
const BASES: readonly AgentChildWorkOperationBasis[] = ['open', 'reported']
const MEMBERSHIPS: readonly AgentChildWorkMembership[] = ['live', 'settled']

function arm<T extends string>(arms: readonly T[], value: unknown): T | undefined {
  return arms.find((candidate) => candidate === value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function clock(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function decodeOperation(value: unknown, observedAt: number): AgentChildWorkOperation | undefined {
  const operation = record(value)
  const toolName = text(operation?.toolName)
  if (!operation || !toolName) {
    return undefined
  }
  const input = text(operation.input)
  return {
    toolName,
    ...(input ? { input } : {}),
    // Only `open` promises an end edge; an arm this build does not know promises nothing.
    basis: arm(BASES, operation.basis) ?? 'reported',
    observedAt: clock(operation.observedAt) ?? observedAt
  }
}

function decodeView(value: unknown): AgentChildWorkView | null {
  const view = record(value)
  const invocation = record(view?.invocation)
  const id = text(view?.id)
  const firstObservedAt = clock(view?.firstObservedAt)
  const observedAt = clock(view?.observedAt)
  const invocationId = text(invocation?.invocationId)
  const generation = clock(invocation?.generation)
  if (
    !view ||
    !id ||
    firstObservedAt === undefined ||
    observedAt === undefined ||
    !invocationId ||
    generation === undefined
  ) {
    return null
  }
  // A membership this build cannot place is kept as a live row that asserts nothing.
  const membership = arm(MEMBERSHIPS, view.membership)
  const settled = membership === 'settled'
  const state = membership ? (arm(STATES, view.state) ?? 'unverifiable') : 'unverifiable'
  const operation = settled ? undefined : decodeOperation(view.operation, observedAt)
  const settledAt = settled ? (clock(view.settledAt) ?? observedAt) : undefined
  const providerId = text(view.providerId)
  const name = text(view.name)
  const description = text(view.description)
  const agentType = text(view.agentType)
  const model = text(view.model)
  const lastMessage = text(view.lastMessage)
  const parentChildWorkId = text(view.parentChildWorkId)
  const totalTokens = clock(view.totalTokens)
  return {
    id,
    ...(providerId ? { providerId } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(agentType ? { agentType } : {}),
    ...(model ? { model } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    ...(parentChildWorkId ? { parentChildWorkId } : {}),
    kind: arm(KINDS, view.kind) ?? 'unknown',
    state: settled ? 'done' : state,
    membership: membership ?? 'live',
    ...(settled ? { outcome: arm(OUTCOMES, view.outcome) ?? 'unknown' } : {}),
    ...(operation ? { operation } : {}),
    firstObservedAt,
    observedAt,
    ...(settledAt !== undefined ? { settledAt } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    // Withholding a stop is a degrade; offering one the host cannot honour is not.
    stoppable: view.stoppable === true,
    invocation: { invocationId, generation }
  }
}

/** A host's published views, or undefined when it published none (an older host). A malformed
 *  entry is dropped; one carrying an arm this build does not know is kept, degraded. */
export function decodeAgentChildWorkViews(value: unknown): AgentChildWorkView[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.flatMap((entry) => {
    const view = decodeView(entry)
    return view ? [view] : []
  })
}

function operationsEqual(
  a: AgentChildWorkOperation | undefined,
  b: AgentChildWorkOperation | undefined,
  clockToleranceMs: number
): boolean {
  if (!a || !b) {
    return a === b
  }
  return (
    a.toolName === b.toolName &&
    a.input === b.input &&
    a.basis === b.basis &&
    Math.abs(a.observedAt - b.observedAt) <= clockToleranceMs
  )
}

function viewsEqual(a: AgentChildWorkView, b: AgentChildWorkView, clockToleranceMs: number) {
  return (
    a.id === b.id &&
    a.providerId === b.providerId &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.description === b.description &&
    a.agentType === b.agentType &&
    a.model === b.model &&
    a.state === b.state &&
    a.membership === b.membership &&
    a.outcome === b.outcome &&
    operationsEqual(a.operation, b.operation, clockToleranceMs) &&
    a.lastMessage === b.lastMessage &&
    a.parentChildWorkId === b.parentChildWorkId &&
    a.firstObservedAt === b.firstObservedAt &&
    Math.abs(a.observedAt - b.observedAt) <= clockToleranceMs &&
    a.settledAt === b.settledAt &&
    a.totalTokens === b.totalTokens &&
    a.stoppable === b.stoppable &&
    a.invocation.invocationId === b.invocation.invocationId &&
    a.invocation.generation === b.invocation.generation
  )
}

/** Field equality for view lists. `clockToleranceMs` lets a reader that does not need per-tick
 *  freshness treat an evidence clock that only advanced by less than that as unchanged. */
export function agentChildWorkViewsEqual(
  a: readonly AgentChildWorkView[] | undefined,
  b: readonly AgentChildWorkView[] | undefined,
  clockToleranceMs = 0
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return false
  }
  return a.every((view, index) => viewsEqual(view, b[index], clockToleranceMs))
}
