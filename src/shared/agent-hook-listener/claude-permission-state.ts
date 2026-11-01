import type { IncomingHttpHeaders } from 'node:http'
import { mergeAgentHookRequestHeaders } from './hook-envelope'
import { createHash } from 'node:crypto'
import { isRecord } from '../agent-status-child-work-value-guards'
import { isAskUserQuestionTool } from '../agent-question-answered-intent'
import type { ParsedAgentStatusPayload } from '../agent-status-types'
import type { ClaudeSettledRequest } from './claude-settled-permission-requests'
import type { HookListenerState } from './listener-state'
import { extractClaudeToolFields } from './providers/claude-tool-fields'
import { readString } from './tool-input-preview'

type ToolCall = {
  id: string
  owner?: string
  session?: string
  prompt?: string
  fingerprint?: string
  settled: boolean
}
type Permission = {
  call: Omit<ToolCall, 'id' | 'settled'>
  candidates: Set<string>
  snapshot: ParsedAgentStatusPayload
  startedAt: number
  agentType?: string
}
export type ClaudePermissionTable = {
  session?: string
  launchToken?: string
  complete: boolean
  calls: Map<string, ToolCall>
  pending: Permission[]
}

const MAX_CALLS = 512

function fingerprint(raw: Record<string, unknown>): string | undefined {
  const tool = readString(raw, 'tool_name')
  if (!tool || !Object.hasOwn(raw, 'tool_input')) {
    return undefined
  }
  const input = JSON.stringify(raw.tool_input, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]])
        )
      : value
  )
  return createHash('sha256').update(`${tool}\0${input}`).digest('hex')
}

function sameCall(a: Omit<ToolCall, 'id' | 'settled'>, b: ToolCall): boolean {
  return (
    a.owner === b.owner &&
    a.session === b.session &&
    a.prompt === b.prompt &&
    a.fingerprint !== undefined &&
    a.fingerprint === b.fingerprint
  )
}

function callKey(owner: string | undefined, id: string): string {
  return JSON.stringify([owner, id])
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
  for (const call of table.calls.values()) {
    if (owns(call.owner)) {
      call.settled = true
    }
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

/** Observe full raw batches before the display/relay preview limits discard tool bodies. */
export function observeClaudePermissionEvent(
  state: HookListenerState,
  paneKey: string,
  event: unknown,
  raw: Record<string, unknown>,
  launchToken: string | undefined,
  replay: boolean
): { permission: boolean; toolUseId?: string; settled?: ClaudeSettledRequest[] } {
  const session = readString(raw, 'session_id')
  const owner = readString(raw, 'agent_id')
  let table = state.claudePermissionByPaneKey.get(paneKey)
  const boundary =
    event === 'SessionStart' &&
    owner === undefined &&
    session !== undefined &&
    (raw.source === 'startup' || raw.source === 'resume' || raw.source === 'clear')
  if (!table || table.launchToken !== launchToken || (boundary && !replay)) {
    table = { session, launchToken, complete: boundary && !replay, calls: new Map(), pending: [] }
    state.claudePermissionByPaneKey.set(paneKey, table)
  } else if (session && owner === undefined && table.session !== session) {
    const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
    const survives = (id: string | undefined): boolean =>
      id !== undefined && roster?.get(id)?.confirmedTeammate === true
    table.pending = table.pending.filter((pending) => survives(pending.call.owner))
    for (const [key, call] of table.calls) {
      if (!survives(call.owner)) {
        table.calls.delete(key)
      }
    }
    table.session = session
    table.complete = false
  }
  if (replay || !session) {
    table.complete = false
  }
  if (
    event === 'UserPromptSubmit' ||
    event === 'Stop' ||
    event === 'StopFailure' ||
    (event === 'PostCompact' && raw.trigger === 'manual')
  ) {
    retireClaudePermissions(state, paneKey, (id) => id === owner)
  }
  if (event === 'SubagentStop') {
    retireClaudePermissions(state, paneKey, (id) => id === owner)
  }

  const call = {
    owner,
    session,
    prompt: readString(raw, 'prompt_id'),
    fingerprint: fingerprint(raw)
  }
  const id = readString(raw, 'tool_use_id')
  const permission =
    event === 'PermissionRequest' && !isAskUserQuestionTool(readString(raw, 'tool_name'))
  if ((event === 'PreToolUse' || permission) && id) {
    const key = callKey(owner, id)
    if (!table.calls.has(key)) {
      if (table.calls.size >= MAX_CALLS) {
        table.complete = false
      } else {
        table.calls.set(key, { ...call, id, settled: false })
      }
    }
    for (const pending of table.pending) {
      const tracked = table.calls.get(key)
      if (tracked && sameCall(pending.call, tracked)) {
        pending.candidates.add(key)
      }
    }
  }
  const matches = [...table.calls.entries()].filter(([, tracked]) =>
    permission && id
      ? tracked.id === id && tracked.owner === owner && tracked.session === session
      : sameCall(call, tracked)
  )
  const candidates = matches.filter(([, tracked]) => !tracked.settled)
  const toolUseId = permission && candidates.length === 1 ? candidates[0][1].id : undefined
  // Retain bounded settled correspondence so delayed hooks cannot resurrect answered requests.
  if (permission && !(matches.length > 0 && candidates.length === 0)) {
    if (
      !table.pending.some(
        (pending) =>
          sameCall(pending.call, { ...call, id: '', settled: false }) ||
          (call.fingerprint === undefined &&
            pending.call.fingerprint === undefined &&
            pending.call.owner === owner &&
            pending.call.session === session &&
            pending.call.prompt === call.prompt &&
            pending.snapshot.toolName === readString(raw, 'tool_name'))
      )
    ) {
      if (!call.fingerprint || !session || candidates.length === 0) {
        table.complete = false
      }
      table.pending.push({
        call,
        candidates: new Set(candidates.map(([key]) => key)),
        snapshot: {
          agentType: 'claude',
          state: 'waiting',
          prompt: '',
          ...state.lastToolByPaneKey.get(paneKey),
          ...extractClaudeToolFields(event, raw)
        },
        startedAt: Date.now(),
        agentType: readString(raw, 'agent_type')
      })
    }
  }
  const resolutions =
    event === 'PostToolBatch'
      ? Array.isArray(raw.tool_calls)
        ? raw.tool_calls
        : []
      : event === 'PostToolUse' || event === 'PostToolUseFailure'
        ? [raw]
        : []
  if (event === 'PostToolBatch' && !Array.isArray(raw.tool_calls)) {
    table.complete = false
  }
  const settled: ClaudeSettledRequest[] = []
  for (const item of resolutions) {
    if (!isRecord(item)) {
      table.complete = false
      continue
    }
    const resolvedId = readString(item, 'tool_use_id')
    if (!resolvedId) {
      table.complete = false
      continue
    }
    const key = callKey(owner, resolvedId)
    let tracked = table.calls.get(key)
    if (!tracked && table.calls.size < MAX_CALLS) {
      tracked = { ...call, fingerprint: fingerprint(item), id: resolvedId, settled: true }
      table.calls.set(key, tracked)
    }
    if (tracked && tracked.session === session) {
      tracked.settled = true
    } else {
      table.complete = false
    }
    if (tracked && tracked.session === session) {
      for (const pending of table.pending) {
        if (sameCall(pending.call, tracked)) {
          pending.candidates.add(key)
        }
      }
    }
    const wasPending = table.pending.some((pending) => pending.candidates.has(key))
    const proof = {
      toolUseId: resolvedId,
      ...(owner ? { toolAgentId: owner } : {}),
      ...(readString(raw, 'agent_type') ? { toolAgentType: readString(raw, 'agent_type') } : {})
    }
    if (wasPending) {
      settled.unshift(proof)
    } else {
      settled.push(proof)
    }
  }
  table.pending = table.pending.filter(
    (pending) =>
      pending.candidates.size === 0 ||
      [...pending.candidates].some((key) => table.calls.get(key)?.settled !== true)
  )
  return { permission, toolUseId, ...(settled.length ? { settled: settled.slice(0, 16) } : {}) }
}
