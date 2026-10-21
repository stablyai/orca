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

function hasRetiredValue(history: RetiredValueHistory | undefined, value: string): boolean {
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

/**
 * Whether a snapshot under `value` may apply. A retired value applies only on an authoritative
 * census that names it, which revives just that value (or its lineage); anything else stays fenced.
 */
export function admitRetiredValueUnderAuthority(
  history: RetiredValueHistory | undefined,
  value: string,
  authoritative: boolean,
  sameValue: (retired: string, value: string) => boolean = (retired, candidate) =>
    retired === candidate
): boolean {
  if (!history?.retired.some((retired) => sameValue(retired, value))) {
    return true
  }
  if (authoritative) {
    history.retired = history.retired.filter((retired) => !sameValue(retired, value))
  }
  return authoritative
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

/**
 * Retirement is a property of the publishing generation, not of the exact string it published
 * under. Matching `retired` exactly let a `:headless-merge:` rebuild of a superseded generation
 * walk past this fence while the bare form hit it, so the same predecessor was accepted or
 * rejected depending on which shape it happened to arrive in.
 */
export function isRetiredSessionTabsPublicationEpoch(
  key: string,
  publicationEpoch: string
): boolean {
  const history = sessionTabsPublicationEpochHistoryByWorktree.get(key)
  return (
    history?.retired.some((retired) =>
      sameSessionTabsPublicationLineage(retired, publicationEpoch)
    ) ?? false
  )
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
  const existing = sessionTabsPublicationEpochHistoryByWorktree.get(key)
  // A headless merge is the same publisher adding runtime-owned surfaces, so it advances the
  // current epoch rather than superseding it. Retiring the base here would have the generation
  // retire itself, and a lineage-aware fence then rejects its own next frame.
  if (existing?.current && sameSessionTabsPublicationLineage(existing.current, publicationEpoch)) {
    existing.current = publicationEpoch
    sessionTabsPublicationEpochHistoryByWorktree.set(key, existing)
    return existing
  }
  const history = noteRetiredValue(existing, publicationEpoch, SESSION_TABS_RETIRED_EPOCH_LIMIT)
  sessionTabsPublicationEpochHistoryByWorktree.set(key, history)
  return history
}
