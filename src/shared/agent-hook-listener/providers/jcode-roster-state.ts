import { continueMainAgentStatus } from '../../agent-lead-status-fold'
import { foldMainAgentWithRowChildWork } from '../../agent-hook-row-child-work-fold'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import {
  finishJcodeSubagent,
  jcodeRosterToSnapshots,
  seedJcodeSubagentRoster,
  upsertJcodeSubagent
} from '../../jcode-subagent-roster'
import { bindJcodeRootSession, type JcodeSessionResolution } from '../jcode-session-registry'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'
import { parseJcodeToolInput } from './jcode-tool-fields'

export function foldJcodeRootPayload(
  state: HookListenerState,
  paneKey: string
): ParsedAgentStatusPayload | null {
  const root = state.jcodeRootPayloadByPaneKey.get(paneKey)
  if (!root) {
    return null
  }
  const roster = state.jcodeSubagentRosterByPaneKey.get(paneKey)
  const subagents = jcodeRosterToSnapshots(roster)
  const confirmed = subagents?.filter(
    (child) =>
      child.state !== 'unverifiable' && roster?.get(child.id)?.restoredFromSnapshot !== true
  )
  const folded = foldMainAgentWithRowChildWork(root.state, { payload: { subagents: confirmed } })
  return { ...root, state: folded.stateName, workingMode: folded.workingMode, subagents }
}

export function saveJcodeRootPayload(
  state: HookListenerState,
  paneKey: string,
  payload: ParsedAgentStatusPayload
): ParsedAgentStatusPayload {
  const previous = state.jcodeRootPayloadByPaneKey.get(paneKey)
  const root = {
    ...payload,
    subagents: undefined,
    mainAgent: continueMainAgentStatus(
      previous?.mainAgent,
      {
        state: payload.state,
        outcome: payload.mainAgent?.outcome
      },
      Date.now()
    )
  }
  state.jcodeRootPayloadByPaneKey.set(paneKey, root)
  return root
}

export function seedJcodeStateFromSnapshot(
  state: HookListenerState,
  paneKey: string,
  event: AgentHookEventPayload
): void {
  if (event.payload.agentType !== 'jcode' || event.connectionId) {
    return
  }
  if (event.providerSession?.key === 'session_id') {
    bindJcodeRootSession(state, paneKey, event.providerSession.id, 'launch')
  }
  if (event.providerSessionOnly) {
    saveJcodeRootPayload(state, paneKey, event.payload)
    return
  }
  const roster = state.jcodeSubagentRosterByPaneKey.get(paneKey) ?? new Map()
  seedJcodeSubagentRoster(roster, event.payload.subagents ?? [])
  state.jcodeSubagentRosterByPaneKey.set(paneKey, roster)
  if (!state.jcodeRootPayloadByPaneKey.has(paneKey)) {
    const payload = normalizeAgentStatusPayload({
      ...event.payload,
      subagents: undefined,
      state: event.payload.mainAgent?.state ?? 'done',
      mainAgent:
        event.payload.mainAgent ?? continueMainAgentStatus(undefined, { state: 'done' }, Date.now())
    })
    if (payload) {
      state.jcodeRootPayloadByPaneKey.set(paneKey, payload)
    }
  }
}

export function normalizeJcodeWorkerEvent(
  state: HookListenerState,
  paneKey: string,
  eventName: string,
  hookPayload: Record<string, unknown>,
  resolution: Extract<JcodeSessionResolution, { kind: 'worker' }>
): ParsedAgentStatusPayload | null {
  const roster = state.jcodeSubagentRosterByPaneKey.get(paneKey) ?? new Map()
  const id = resolution.binding.sessionId
  const existing = roster.get(id)
  if (eventName === 'session_end') {
    finishJcodeSubagent(roster, id)
  } else if (
    eventName === 'session_start' ||
    eventName === 'turn_start' ||
    eventName === 'turn_end'
  ) {
    upsertJcodeSubagent(
      roster,
      id,
      {
        agentType: resolution.metadata?.shortName,
        description: resolution.metadata?.title,
        model: eventName === 'session_start' ? undefined : readString(hookPayload, 'model'),
        state:
          eventName === 'turn_start'
            ? 'working'
            : eventName === 'turn_end'
              ? 'idle'
              : existing?.restoredFromSnapshot
                ? 'idle'
                : (existing?.state ?? 'idle')
      },
      Date.now()
    )
    if (eventName === 'turn_start') {
      const tracked = roster.get(id)
      if (tracked) {
        tracked.report = undefined
      }
    }
  } else if (eventName === 'pre_tool' || eventName === 'post_tool') {
    if (!existing) {
      return null
    }
    const input =
      eventName === 'post_tool' && hookPayload.status === 'ok' && hookPayload.tool_name === 'swarm'
        ? parseJcodeToolInput(hookPayload)
        : undefined
    const report =
      typeof input === 'object' &&
      input !== null &&
      'action' in input &&
      input.action === 'report' &&
      'message' in input &&
      typeof input.message === 'string'
        ? input.message
        : undefined
    upsertJcodeSubagent(
      roster,
      id,
      {
        agentType: resolution.metadata?.shortName,
        description: resolution.metadata?.title,
        state: existing.restoredFromSnapshot ? 'idle' : existing.state,
        report
      },
      Date.now()
    )
  } else {
    return null
  }
  if (roster.size) {
    state.jcodeSubagentRosterByPaneKey.set(paneKey, roster)
  } else {
    state.jcodeSubagentRosterByPaneKey.delete(paneKey)
  }
  return foldJcodeRootPayload(state, paneKey)
}
