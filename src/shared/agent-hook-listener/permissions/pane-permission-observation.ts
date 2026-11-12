import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import { agentCommandLineBypassesPermissions } from '../../agent-launch/permissions/agent-command-line-permissions'
import { YOLO_TUI_AGENT_ARGS } from '../../agent-launch/permissions/tui-agent-permissions'
import {
  readHookAgentProcess,
  type AgentProcessIdentity
} from '../../agent-status/process/agent-process-presence'
import { parseHookEnvelope } from '../hook-envelope'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import {
  isFreshSessionStartHook,
  isSubagentHookPayload,
  readHookReportedPermissionMode
} from './hook-reported-permission-mode'
import { isNewTurnEvent } from '../provider-event-routing'
import type { AgentHookSource } from '../transport/agent-hook-relay'

export type PaneAgentCommandLineReader = (
  paneKey: string,
  agent: TuiAgent,
  process?: AgentProcessIdentity
) => Promise<string | null>

export type PaneCliBypassObservation = {
  agent: TuiAgent
  bypass?: boolean
  inFlight?: Promise<void>
}

const IDENTITY_PANE_KEY = (paneKey: string): string => paneKey

/** Observe the pane's live CLI argv on turn/session boundaries when hooks omit permission_mode. */
export function observePanePermissionBeforeHook(
  state: HookListenerState,
  reader: PaneAgentCommandLineReader | undefined,
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string,
  resolvePaneKey: (paneKey: string) => string = IDENTITY_PANE_KEY
): Promise<void> | undefined {
  if (!reader || source === 'claude' || !isTuiAgent(source) || !YOLO_TUI_AGENT_ARGS[source]) {
    return undefined
  }
  const envelope = parseHookEnvelope(state, source, body, expectedEnv)
  if (!envelope) {
    return undefined
  }
  const paneKey = resolvePaneKey(envelope.paneKey)
  const hookPayload = envelope.hookPayloadRecord
  if (isSubagentHookPayload(hookPayload)) {
    return state.paneCliBypassObservationByPaneKey.get(paneKey)?.inFlight
  }
  if (readHookReportedPermissionMode(source, hookPayload) !== undefined) {
    state.paneCliBypassObservationByPaneKey.delete(paneKey)
    return undefined
  }
  const cached = state.paneCliBypassObservationByPaneKey.get(paneKey)
  const boundary =
    isNewTurnEvent(source, envelope.eventName) ||
    isFreshSessionStartHook(source, hookPayload, envelope.eventName)
  if (cached?.agent === source) {
    if (cached.inFlight) {
      return cached.inFlight
    }
    if (!boundary) {
      return undefined
    }
  }
  const entry: PaneCliBypassObservation = { agent: source }
  const sender = readHookAgentProcess(source, envelope.record.agentProcess)
  const promise = reader(paneKey, source, sender)
    .catch(() => null)
    .then((commandLine) => {
      if (state.paneCliBypassObservationByPaneKey.get(resolvePaneKey(paneKey)) !== entry) {
        return
      }
      entry.bypass =
        commandLine !== null && agentCommandLineBypassesPermissions(source, commandLine)
      entry.inFlight = undefined
    })
  entry.inFlight = promise
  state.paneCliBypassObservationByPaneKey.set(paneKey, entry)
  return promise
}

export function applyObservedPanePermission(
  state: HookListenerState,
  event: AgentHookEventPayload | null,
  isReplay: boolean,
  resolvePaneKey: (paneKey: string) => string = IDENTITY_PANE_KEY
): AgentHookEventPayload | null {
  if (isReplay || !event?.providerSession) {
    return event
  }
  const observed = state.paneCliBypassObservationByPaneKey.get(resolvePaneKey(event.paneKey))
  if (!observed || observed.agent !== event.payload.agentType || observed.bypass === undefined) {
    return event
  }
  if (observed.bypass) {
    return {
      ...event,
      providerSession: { ...event.providerSession, permissionMode: 'bypassPermissions' }
    }
  }
  if (event.providerSession.permissionMode === undefined) {
    return event
  }
  const { permissionMode: _dropped, ...restSession } = event.providerSession
  return { ...event, providerSession: restSession }
}
