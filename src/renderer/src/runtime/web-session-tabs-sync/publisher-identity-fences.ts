import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  latestReceivedSessionTabsFrameByEnvironment,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRuntimeHistoryByEnvironment,
  type RetiredValueHistory,
  type SessionTabsPublicationEpochHistory,
  type SessionTabsRuntimeHistory
} from './state'

const SESSION_TABS_RETIRED_EPOCH_LIMIT = 8
const SESSION_TABS_RETIRED_RUNTIME_ID_LIMIT = 8

export function hasRetiredValue(history: RetiredValueHistory | undefined, value: string): boolean {
  return history?.retired.includes(value) ?? false
}

export function noteRetiredValue(
  history: RetiredValueHistory | undefined,
  value: string,
  retiredLimit: number
): RetiredValueHistory {
  if (!history) {
    return { current: value, retired: [] }
  }
  if (history.current === value) {
    return history
  }
  if (history.current && !history.retired.includes(history.current)) {
    history.retired.push(history.current)
    if (history.retired.length > retiredLimit) {
      history.retired.splice(0, history.retired.length - retiredLimit)
    }
  }
  history.current = value
  return history
}

function normalizeSessionTabsRuntimeId(runtimeId: unknown): string | undefined {
  if (typeof runtimeId !== 'string') {
    return undefined
  }
  const trimmed = runtimeId.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function getSessionTabsRuntimeIdFromResponse(
  response: RuntimeRpcResponse<unknown>
): string | undefined {
  return response.ok ? normalizeSessionTabsRuntimeId(response._meta?.runtimeId) : undefined
}

export function recordReceivedWebSessionTabsEnvironmentFrame(
  environmentId: string,
  receivedFrame: number
): void {
  const current = latestReceivedSessionTabsFrameByEnvironment.get(environmentId) ?? 0
  if (receivedFrame > current) {
    latestReceivedSessionTabsFrameByEnvironment.set(environmentId, receivedFrame)
  }
}

export function isRetiredSessionTabsRuntimeId(environmentId: string, runtimeId: string): boolean {
  return hasRetiredValue(sessionTabsRuntimeHistoryByEnvironment.get(environmentId), runtimeId)
}

function noteSessionTabsRuntimeId(
  environmentId: string,
  runtimeId: string
): SessionTabsRuntimeHistory {
  const history = noteRetiredValue(
    sessionTabsRuntimeHistoryByEnvironment.get(environmentId),
    runtimeId,
    SESSION_TABS_RETIRED_RUNTIME_ID_LIMIT
  )
  sessionTabsRuntimeHistoryByEnvironment.set(environmentId, history)
  return history
}

export function isCurrentSessionTabsRuntimeId(environmentId: string, runtimeId: string): boolean {
  const history = sessionTabsRuntimeHistoryByEnvironment.get(environmentId)
  return history === undefined || history.current === runtimeId
}

export function isCurrentSessionTabsRuntimeFrame(
  environmentId: string,
  runtimeId?: string
): boolean {
  return (
    runtimeId === undefined ||
    (!isRetiredSessionTabsRuntimeId(environmentId, runtimeId) &&
      isCurrentSessionTabsRuntimeId(environmentId, runtimeId))
  )
}

/** Returns false for a runtime identity already superseded on this environment. */
export function acceptSessionTabsRuntimeId(
  environmentId: string,
  runtimeId: string,
  receivedFrame?: number
): boolean {
  const history = sessionTabsRuntimeHistoryByEnvironment.get(environmentId)
  const latestReceivedFrame = latestReceivedSessionTabsFrameByEnvironment.get(environmentId) ?? 0
  // A late bootstrap response may carry the predecessor process id. Do not
  // let that older frame retire the runtime that already published newer data.
  if (
    receivedFrame !== undefined &&
    receivedFrame < latestReceivedFrame &&
    history !== undefined &&
    history.current !== runtimeId
  ) {
    return false
  }
  if (isRetiredSessionTabsRuntimeId(environmentId, runtimeId)) {
    return false
  }
  noteSessionTabsRuntimeId(environmentId, runtimeId)
  return true
}

export function isRetiredSessionTabsPublicationEpoch(
  key: string,
  publicationEpoch: string
): boolean {
  return hasRetiredValue(sessionTabsPublicationEpochHistoryByWorktree.get(key), publicationEpoch)
}

/**
 * A headless merge keeps the renderer publication as its base epoch while
 * adding runtime-owned surfaces. Treat both forms as one ordering lineage.
 */
export function sameSessionTabsPublicationLineage(left: string, right: string): boolean {
  return (
    left === right ||
    ((left.includes(':headless-merge:') || right.includes(':headless-merge:')) &&
      left.split(':headless-merge:')[0] === right.split(':headless-merge:')[0])
  )
}

export function isHeadlessMergeSessionTabsPublication(publicationEpoch: string): boolean {
  return publicationEpoch.includes(':headless-merge:')
}

export function noteSessionTabsPublicationEpoch(
  key: string,
  publicationEpoch: string
): SessionTabsPublicationEpochHistory {
  const history = noteRetiredValue(
    sessionTabsPublicationEpochHistoryByWorktree.get(key),
    publicationEpoch,
    SESSION_TABS_RETIRED_EPOCH_LIMIT
  )
  sessionTabsPublicationEpochHistoryByWorktree.set(key, history)
  return history
}
