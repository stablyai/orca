import { launchStateLifecycle } from './structured-agent-session-launch-lifecycle'
import type { StructuredLaunchFailure } from './structured-agent-session-launch-failure'
import type { StructuredLaunchRecoveryState } from './structured-agent-session-launch-recovery'
import type { StructuredLaunchSelection } from './structured-agent-session-launch-options'
import type {
  StructuredAgentLaunchOptions,
  StructuredLaunchCallerGroup
} from './structured-agent-session-launch-callers'
import {
  deleteStructuredAgentLaunchRecord,
  readStructuredAgentLaunchRecord,
  updateStructuredAgentLaunchRecords,
  writeStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import {
  type StructuredAgentLaunchPersistedRecord,
  structuredAgentLaunchRecordFor
} from './structured-agent-session-launch-record'

// Leaf state store so launch-input and the registry share launch state without an import cycle.
export type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  /** Fixed by the caller that opened this launch so coalesced prompts use one delivery mode. */
  promptDelivery: StructuredAgentLaunchOptions['promptDelivery']
  callers: StructuredLaunchCallerGroup
  /** The host's refusal behind the last failed attempt, worded beside Retry. Absent when the
   *  failure named none. */
  failure?: StructuredLaunchFailure
  selection: StructuredLaunchSelection
  /** A host list showed the chat, so its create reply needs no protection from older lists. */
  hostListed?: true
  /** The bounded caller finished; this identity may still observe exact late evidence. */
  operationEnded?: true
}

const structuredLaunchesBySessionId = new Map<string, StructuredLaunchState>()
/** Null when the writer can't name its sessions, so subscribers re-read every launch. */
type StructuredLaunchListener = (sessionIds: readonly string[] | null) => void
const structuredLaunchListeners = new Set<StructuredLaunchListener>()

export function structuredLaunchSessionIds(): IterableIterator<string> {
  return structuredLaunchesBySessionId.keys()
}

export function clearStructuredLaunchStateStoreForTests(): void {
  structuredLaunchesBySessionId.clear()
  structuredLaunchListeners.clear()
}

export function notifyStructuredLaunchListeners(sessionIds?: string | readonly string[]): void {
  function* changes(): Generator<readonly [string, StructuredAgentLaunchPersistedRecord | null]> {
    for (const state of structuredLaunchesBySessionId.values()) {
      yield [state.intent.sessionId, structuredLaunchRecord(state)]
    }
  }
  updateStructuredAgentLaunchRecords(changes())
  publishStructuredLaunchChange(sessionIds)
}

export function publishStructuredLaunchChange(sessionIds?: string | readonly string[]): void {
  const changed = typeof sessionIds === 'string' ? [sessionIds] : (sessionIds ?? null)
  for (const listener of structuredLaunchListeners) {
    listener(changed)
  }
}

export function subscribeStructuredAgentLaunchStatus(
  listener: StructuredLaunchListener
): () => void {
  structuredLaunchListeners.add(listener)
  return () => structuredLaunchListeners.delete(listener)
}

export function getStructuredLaunchStateBySessionId(
  sessionId: string
): StructuredLaunchState | undefined {
  return structuredLaunchesBySessionId.get(sessionId)
}

export function setStructuredLaunchState(state: StructuredLaunchState): void {
  structuredLaunchesBySessionId.set(state.intent.sessionId, state)
  persistStructuredLaunchState(state)
}

export function deleteStructuredLaunchStateIfCurrent(state: StructuredLaunchState): boolean {
  if (structuredLaunchesBySessionId.get(state.intent.sessionId) !== state) {
    return false
  }
  structuredLaunchesBySessionId.delete(state.intent.sessionId)
  deleteStructuredAgentLaunchRecord(state.intent.sessionId)
  return true
}

function persistStructuredLaunchState(state: StructuredLaunchState): void {
  const record = structuredLaunchRecord(state)
  if (record) {
    writeStructuredAgentLaunchRecord(record)
  } else {
    deleteStructuredAgentLaunchRecord(state.intent.sessionId)
  }
}

function structuredLaunchRecord(
  state: StructuredLaunchState
): StructuredAgentLaunchPersistedRecord | null {
  const lifecycle = launchStateLifecycle(state)
  if (lifecycle === 'published' || lifecycle === 'cancelled') {
    return null
  }
  return {
    ...structuredAgentLaunchRecordFor(state.intent, lifecycle),
    ...(lifecycle === 'failed' ? { failedAt: state.callers.failedAt } : {})
  }
}

export function getPersistedStructuredAgentLaunchRecord(
  sessionId: string
): StructuredAgentLaunchPersistedRecord | undefined {
  return readStructuredAgentLaunchRecord(sessionId)
}

export function structuredLaunchStates(): IterableIterator<StructuredLaunchState> {
  return structuredLaunchesBySessionId.values()
}
