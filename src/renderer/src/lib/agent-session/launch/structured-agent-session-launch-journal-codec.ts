/** How saved launch rows and cancellation tombstones are read back from, and written to, storage. */

import {
  validRecord,
  parseHostLaunchFirstTurn,
  parseStructuredLaunchSurfaceAddress,
  type StructuredAgentLaunchPersistedRecord
} from './structured-agent-session-launch-record'
import { parseStructuredLaunchSeedOptions } from '../../../../../shared/native-chat/input/native-chat-session-option-defaults'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'

const REMOTE_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function readSavedLaunchRecord(
  value: unknown
): StructuredAgentLaunchPersistedRecord | undefined {
  if (!validRecord(value)) {
    return undefined
  }
  const seedOptions = parseStructuredLaunchSeedOptions(
    'seedOptions' in value ? value.seedOptions : undefined
  )
  const surfaceAddress = parseStructuredLaunchSurfaceAddress(
    'surfaceAddress' in value ? value.surfaceAddress : undefined
  )
  const hostLaunchFirstTurn = parseHostLaunchFirstTurn(
    value.hostLaunchFirstTurn,
    value.firstMessage
  )
  const { seedOptions: _stored, surfaceAddress: _address, ...rest } = value
  return {
    ...rest,
    ...(surfaceAddress ? { surfaceAddress } : {}),
    // Unreadable is dropped: a launch never runs on a guess at its first turn.
    hostLaunchFirstTurn,
    ...(seedOptions ? { seedOptions } : {}),
    executionHostId: parseExecutionHostId(value.executionHostId)?.id ?? LOCAL_EXECUTION_HOST_ID,
    // A renderer reload cannot prove a pending request was delivered.
    lifecycle: value.lifecycle === 'pending' ? 'visibility-unknown' : value.lifecycle
  }
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

type SavedTombstone = { sessionId: string; executionHostId: ExecutionHostId; cancelledAt?: number }

/** A bare id is a local chat's tombstone, the only kind older builds wrote and still read. A
 *  paired host's expires once its host has not answered for the retention period. */
export function readSavedLaunchTombstone(value: unknown): SavedTombstone | undefined {
  if (validSessionId(value)) {
    return { sessionId: value, executionHostId: LOCAL_EXECUTION_HOST_ID }
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const sessionId = 'sessionId' in value ? value.sessionId : undefined
  const host = parseExecutionHostId(
    'executionHostId' in value && typeof value.executionHostId === 'string'
      ? value.executionHostId
      : null
  )
  const cancelledAt = 'cancelledAt' in value ? value.cancelledAt : undefined
  if (
    !validSessionId(sessionId) ||
    !host ||
    typeof cancelledAt !== 'number' ||
    Date.now() - cancelledAt > REMOTE_TOMBSTONE_TTL_MS
  ) {
    return undefined
  }
  return { sessionId, executionHostId: host.id, cancelledAt }
}

export function savedLaunchTombstone(
  sessionId: string,
  executionHostId: ExecutionHostId,
  cancelledAt: number | undefined
): unknown {
  return executionHostId === LOCAL_EXECUTION_HOST_ID
    ? sessionId
    : { sessionId, executionHostId, cancelledAt: cancelledAt ?? Date.now() }
}
