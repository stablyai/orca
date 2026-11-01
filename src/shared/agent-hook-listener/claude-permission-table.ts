import type { IncomingHttpHeaders } from 'node:http'
import { mergeAgentHookRequestHeaders } from './hook-envelope'
import { isRecord } from '../agent-status-child-work-value-guards'
import type { ParsedAgentStatusPayload } from '../agent-status-types'
import type { HookListenerState } from './listener-state'

type ClaudeToolCall = {
  id: string
  owner?: string
  session?: string
  prompt?: string
  fingerprint?: string
  settled: boolean
}
export type ClaudeCallIdentity = Omit<ClaudeToolCall, 'id' | 'settled'>
type ClaudePermission = {
  call: ClaudeCallIdentity
  /** Set when the request named its invocation; the entry then stands for that call alone. */
  key?: string
  /** Unresolved invocations these requests may belong to; resolved ones leave the set. */
  candidates: Set<string>
  /** Equal-input requests can be distinct invocations, so each needs its own resolved invocation. */
  requests: number
  resolved: number
  snapshot: ParsedAgentStatusPayload
  startedAt: number
  agentType?: string
}
export type ClaudePermissionTable = {
  session?: string
  launchToken?: string
  complete: boolean
  calls: Map<string, ClaudeToolCall>
  pending: ClaudePermission[]
  /** Newest request past the pending bound; its owner is unprovable, so only a session or run end clears it. */
  overflow?: ClaudePermission
}

const MAX_CALLS = 512
const MAX_PENDING = 64

export function sameClaudeCall(a: ClaudeCallIdentity, b: ClaudeCallIdentity): boolean {
  return (
    a.owner === b.owner &&
    a.session === b.session &&
    a.prompt === b.prompt &&
    a.fingerprint !== undefined &&
    a.fingerprint === b.fingerprint
  )
}

/** Settled entries are only delayed-delivery tombstones, so the oldest yields first; unresolved calls never do. */
export function admitClaudeCall(
  table: ClaudePermissionTable,
  key: string,
  call: ClaudeToolCall
): boolean {
  if (table.calls.size >= MAX_CALLS) {
    let reclaimed = false
    for (const [tracked, entry] of table.calls) {
      if (entry.settled) {
        table.calls.delete(tracked)
        reclaimed = true
        break
      }
    }
    if (!reclaimed) {
      table.complete = false
      return false
    }
  }
  table.calls.set(key, call)
  return true
}

export function claudePermissionOpen(permission: ClaudePermission): boolean {
  return permission.candidates.size > 0 || permission.resolved < permission.requests
}

/** An exact id names the request only while one candidate could still answer it. */
export function claudePermissionToolUseId(
  table: ClaudePermissionTable,
  permission: ClaudePermission
): string | undefined {
  return permission.candidates.size === 1 && permission.requests - permission.resolved <= 1
    ? table.calls.get([...permission.candidates][0])?.id
    : undefined
}

export function addClaudePermission(
  table: ClaudePermissionTable,
  permission: ClaudePermission
): void {
  if (table.pending.length < MAX_PENDING) {
    table.pending.push(permission)
    return
  }
  table.complete = false
  table.overflow = permission
}

/** Retire only the owner whose turn ended; parallel children may still need an answer. */
export function retireClaudePermissions(
  state: HookListenerState,
  paneKey: string,
  owns: (owner: string | undefined) => boolean
): void {
  const table = state.claudePermissionByPaneKey.get(paneKey)
  if (!table) {
    return
  }
  table.pending = table.pending.filter((pending) => !owns(pending.call.owner))
  for (const [key, call] of table.calls) {
    if (owns(call.owner)) {
      table.calls.delete(key)
    }
  }
}

/** A replaced or exited session ends every owner but confirmed teammates, which outlive it. */
export function retireClaudeSessionPermissions(state: HookListenerState, paneKey: string): void {
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  retireClaudePermissions(
    state,
    paneKey,
    (owner) => owner === undefined || roster?.get(owner)?.confirmedTeammate !== true
  )
  const table = state.claudePermissionByPaneKey.get(paneKey)
  if (table) {
    table.overflow = undefined
    table.complete = false
  }
}

export function invalidateClaudePermissions(state: HookListenerState, paneKey?: string): void {
  if (paneKey !== undefined) {
    const table = state.claudePermissionByPaneKey.get(paneKey)
    if (table) {
      table.complete = false
    }
  } else {
    for (const table of state.claudePermissionByPaneKey.values()) {
      table.complete = false
    }
  }
}

/** The caller has authenticated the transport; only existing header attribution can identify a gap. */
export function invalidateRejectedClaudeHook(
  state: HookListenerState,
  headers: IncomingHttpHeaders,
  resolvePaneKey: (paneKey: string) => string = (paneKey) => paneKey
): void {
  const envelope = mergeAgentHookRequestHeaders({}, headers)
  if (!isRecord(envelope) || typeof envelope.paneKey !== 'string') {
    return
  }
  const table = state.claudePermissionByPaneKey.get(resolvePaneKey(envelope.paneKey))
  if (table && table.launchToken === envelope.launchToken) {
    table.complete = false
  }
}
