import { createHash } from 'node:crypto'
import { isRecord } from '../agent-status-child-work-value-guards'
import { isAskUserQuestionTool } from '../agent-question-answered-intent'
import type { ClaudeSettledRequest } from './claude-settled-permission-requests'
import type { HookListenerState } from './listener-state'
import { extractClaudeToolFields } from './providers/claude-tool-fields'
import { readString } from './tool-input-preview'
import {
  addClaudePermission,
  admitClaudeCall,
  claudePermissionOpen,
  claudePermissionToolUseId,
  retireClaudePermissions,
  retireClaudeSessionPermissions,
  sameClaudeCall,
  type ClaudeCallIdentity,
  type ClaudePermissionTable
} from './claude-permission-table'

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

function callKey(owner: string | undefined, id: string): string {
  return JSON.stringify([owner, id])
}

/** Anonymous equal-signature requests share one entry that counts them; identified requests never merge. */
function equalAnonymousRequest(
  table: ClaudePermissionTable,
  call: ClaudeCallIdentity,
  toolName: string | undefined
) {
  return table.pending.find(
    (pending) =>
      pending.key === undefined &&
      (sameClaudeCall(pending.call, call) ||
        (call.fingerprint === undefined &&
          pending.call.fingerprint === undefined &&
          pending.call.owner === call.owner &&
          pending.call.session === call.session &&
          pending.call.prompt === call.prompt &&
          pending.snapshot.toolName === toolName))
  )
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
    retireClaudeSessionPermissions(state, paneKey)
    table.session = session
  }
  if (replay || !session) {
    table.complete = false
  }
  if (
    event === 'UserPromptSubmit' ||
    event === 'Stop' ||
    event === 'StopFailure' ||
    event === 'SubagentStop' ||
    (event === 'PostCompact' && raw.trigger === 'manual')
  ) {
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
    if (!table.calls.has(key) && admitClaudeCall(table, key, { ...call, id, settled: false })) {
      for (const pending of table.pending) {
        if (pending.key === undefined && sameClaudeCall(pending.call, call)) {
          pending.candidates.add(key)
        }
      }
    }
  }
  let toolUseId: string | undefined
  if (permission) {
    const key = id ? callKey(owner, id) : undefined
    const candidates = [...table.calls]
      .filter(([tracked, entry]) =>
        key ? tracked === key && entry.session === session : sameClaudeCall(call, entry)
      )
      .filter(([, entry]) => !entry.settled)
      .map(([tracked]) => tracked)
    const settledRepeat = key !== undefined && table.calls.get(key)?.settled === true
    const toolName = readString(raw, 'tool_name')
    let request = key
      ? table.pending.find((pending) => pending.key === key)
      : equalAnonymousRequest(table, call, toolName)
    if (request && !key) {
      // Equal input cannot tell a repeat from another invocation, so the entry now needs one more resolution.
      request.requests += 1
      for (const candidate of candidates) {
        request.candidates.add(candidate)
      }
      table.complete = false
    } else if (!request && !settledRepeat) {
      if (!call.fingerprint || !session || candidates.length === 0) {
        table.complete = false
      }
      request = {
        call,
        key,
        candidates: new Set(candidates),
        requests: 1,
        resolved: 0,
        snapshot: {
          agentType: 'claude',
          state: 'waiting',
          prompt: '',
          ...state.lastToolByPaneKey.get(paneKey),
          ...extractClaudeToolFields(event, raw)
        },
        startedAt: Date.now(),
        agentType: readString(raw, 'agent_type')
      }
      addClaudePermission(table, request)
    }
    toolUseId = request ? claudePermissionToolUseId(table, request) : undefined
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
    const resolvedId = isRecord(item) ? readString(item, 'tool_use_id') : undefined
    if (!isRecord(item) || !resolvedId) {
      table.complete = false
      continue
    }
    const key = callKey(owner, resolvedId)
    const tracked = table.calls.get(key)
    let wasPending = false
    if (tracked && tracked.session !== session) {
      table.complete = false
    } else if (!tracked?.settled) {
      // A fresh resolution can bind a request that had no correspondence; settled history never does.
      const resolved = {
        ...call,
        ...tracked,
        fingerprint: fingerprint(item) ?? tracked?.fingerprint
      }
      for (const pending of table.pending) {
        if (pending.candidates.delete(key) || pending.key === key) {
          pending.resolved += 1
          wasPending = true
        }
      }
      // An invocation no request claimed may be the one an unmatched anonymous request asked about.
      const unmatched = wasPending
        ? undefined
        : table.pending.find(
            (pending) =>
              pending.key === undefined &&
              pending.resolved < pending.requests &&
              sameClaudeCall(pending.call, resolved)
          )
      if (unmatched) {
        unmatched.resolved += 1
        wasPending = true
      }
      if (tracked) {
        tracked.settled = true
      } else {
        admitClaudeCall(table, key, { ...resolved, id: resolvedId, settled: true })
      }
    }
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
  table.pending = table.pending.filter(claudePermissionOpen)
  return { permission, toolUseId, ...(settled.length ? { settled: settled.slice(0, 16) } : {}) }
}
