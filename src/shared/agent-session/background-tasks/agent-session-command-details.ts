// Which listed command children the host can return an exact command for. Chat-only roster metadata:
// never on generic child views, exports, mirrors, legacy tasks or phone frames, and never the command.

import type { AgentChildWorkView } from '../../agent-status/child-work/agent-status-child-work-view'

/** One command child's exact invocation; the detail read and every check name all three. */
export type AgentSessionCommandDetailTuple = {
  childWorkId: string
  invocationId: string
  generation: number
}

export function commandDetailTupleKey(tuple: AgentSessionCommandDetailTuple): string {
  return JSON.stringify([tuple.childWorkId, tuple.invocationId, tuple.generation])
}

export function commandDetailTupleOf(view: AgentChildWorkView): AgentSessionCommandDetailTuple {
  return {
    childWorkId: view.id,
    invocationId: view.invocation.invocationId,
    generation: view.invocation.generation
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactTuple(value: unknown): AgentSessionCommandDetailTuple | null {
  if (!isRecord(value)) {
    return null
  }
  const { childWorkId, invocationId, generation } = value
  if (
    Object.keys(value).length !== 3 ||
    typeof childWorkId !== 'string' ||
    childWorkId.length === 0 ||
    typeof invocationId !== 'string' ||
    invocationId.length === 0 ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return null
  }
  return { childWorkId, invocationId, generation }
}

/** Strict: a malformed list means none are available. A tuple counts only when it names a command
 *  child of the same roster at that child's current invocation; duplicates and strangers drop. */
export function decodeCommandDetailsAvailable(
  raw: unknown,
  children: readonly AgentChildWorkView[] | undefined
): AgentSessionCommandDetailTuple[] | undefined {
  if (raw === undefined || !Array.isArray(raw) || !children) {
    return undefined
  }
  if (raw.length > children.length) {
    return undefined
  }
  const commands = new Map(
    children
      .filter((child) => child.kind === 'command')
      .map((child) => [commandDetailTupleKey(commandDetailTupleOf(child)), child] as const)
  )
  const kept = new Map<string, AgentSessionCommandDetailTuple>()
  for (const value of raw) {
    const tuple = exactTuple(value)
    if (!tuple) {
      return undefined
    }
    const key = commandDetailTupleKey(tuple)
    if (commands.has(key)) {
      kept.set(key, tuple)
    }
  }
  return kept.size > 0 ? [...kept.values()] : undefined
}

export function commandDetailsAvailableEqual(
  left: readonly AgentSessionCommandDetailTuple[] | undefined,
  right: readonly AgentSessionCommandDetailTuple[] | undefined
): boolean {
  if (left === right) {
    return true
  }
  if ((left?.length ?? 0) !== (right?.length ?? 0)) {
    return false
  }
  const keys = new Set((left ?? []).map(commandDetailTupleKey))
  return (right ?? []).every((tuple) => keys.has(commandDetailTupleKey(tuple)))
}

/** The set a reader may open, from an admitted roster replacement; null and absent mean none. */
export function commandDetailKeysOf(
  state: { commandDetailsAvailable?: readonly AgentSessionCommandDetailTuple[] } | null | undefined
): ReadonlySet<string> {
  return new Set((state?.commandDetailsAvailable ?? []).map(commandDetailTupleKey))
}
