import { codexRosterToSnapshots } from '../codex/codex-subagent-roster'
import {
  normalizeAgentStatusPayload,
  type AgentStatusState,
  type AgentWorkingMode,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import { continueMainAgentStatus } from '../../../agent-status/lifecycle/agent-lead-status-fold'
import { clearPaneTurnCacheState, type HookListenerState } from '../../listener-state'
import { resolvePrompt, resolveToolState } from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'
import { readString } from '../../tool-input-preview'
import {
  applyDroidChildEvent,
  applyDroidLeadEvent,
  resolveDroidRowStatus,
  type DroidNotification
} from './droid-session-status'
import {
  droidPaneSessions,
  type DroidHookAdmission,
  type DroidPaneSessions
} from './droid-sessions'
import {
  isDroidAskUserTool,
  isDroidHighRiskToolUse,
  isDroidIdleNotification,
  isDroidPermissionNotification
} from './droid-tool-fields'
import { droidVerdictFields } from './droid-turn-outcome'
import type { AgentVerdictFields } from '../../../agent-status/lifecycle/agent-main-agent-verdict'

function droidNotification(hookPayload: Record<string, unknown>): DroidNotification {
  const type = readString(hookPayload, 'notification_type')
  const message = readString(hookPayload, 'message')
  if (type === 'permission_prompt' || isDroidPermissionNotification(message)) {
    return 'permission'
  }
  return type === 'idle_prompt' || isDroidIdleNotification(message) ? 'idle' : undefined
}

function buildDroidStatusPayload(
  state: HookListenerState,
  paneKey: string,
  fields: {
    eventName: unknown
    promptText: string
    hookPayload: Record<string, unknown>
    stateName: AgentStatusState
    workingMode?: AgentWorkingMode
    sessions?: DroidPaneSessions
    updateLead: boolean
    verdict?: AgentVerdictFields
  }
): ParsedAgentStatusPayload | null {
  const { eventName, hookPayload, sessions, updateLead } = fields
  const snapshot = updateLead
    ? resolveToolState(state, paneKey, extractToolFields('droid', eventName, hookPayload), {
        resetOnNewTurn: isNewTurnEvent('droid', eventName)
      })
    : (state.lastToolByPaneKey.get(paneKey) ?? {})
  const subagents = codexRosterToSnapshots(sessions?.roster)
  // Why: a row held open by a child alone still needs the lead's own state to be read as held open.
  const heldOpen =
    sessions !== undefined && sessions.lead?.state === 'done' && fields.stateName !== 'done'
  const mainAgent =
    sessions && (subagents || heldOpen)
      ? (sessions.lead ?? continueMainAgentStatus(undefined, { state: 'working' }, Date.now()))
      : undefined

  return normalizeAgentStatusPayload({
    state: fields.stateName,
    workingMode: fields.workingMode,
    prompt: resolvePrompt(state, paneKey, fields.promptText, {
      resetOnNewTurn: updateLead && isNewTurnEvent('droid', eventName)
    }),
    agentType: 'droid',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    subagents,
    mainAgent,
    ...fields.verdict
  })
}

/**
 * The pane's row once its background-child lease has run out, for a wakeup with no hook behind it.
 * The lease is spent here so the stored row stops asking for another wakeup.
 */
export function settleDroidLeaseExpiry(
  state: HookListenerState,
  paneKey: string
): ParsedAgentStatusPayload | null {
  const sessions = droidPaneSessions(state, paneKey)
  if (!sessions) {
    return null
  }
  sessions.leaseUntil = undefined
  return buildDroidStatusPayload(state, paneKey, {
    eventName: undefined,
    promptText: '',
    hookPayload: {},
    ...resolveDroidRowStatus(sessions),
    sessions,
    updateLead: false
  })
}

export function normalizeDroidEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  admission: Extract<DroidHookAdmission, { kind: 'lead' | 'child' }> = {
    kind: 'lead'
  }
): ParsedAgentStatusPayload | null {
  const notification = droidNotification(hookPayload)
  const droidToolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
  // Why: AskUser and high-risk calls are known to need the user at PreToolUse; lower-impact approvals arrive later as a Notification permission prompt.
  const needsUserAtToolUse =
    eventName === 'PreToolUse' &&
    (isDroidAskUserTool(droidToolName) || isDroidHighRiskToolUse(hookPayload))
  if (admission.kind === 'child') {
    const { sessions, sessionId } = admission
    if (!applyDroidChildEvent(sessions, sessionId, eventName, notification, needsUserAtToolUse)) {
      return null
    }
    // Why: a child's task text and tool calls describe the child, never the row's turn.
    return buildDroidStatusPayload(state, paneKey, {
      eventName,
      promptText: '',
      hookPayload,
      ...resolveDroidRowStatus(sessions),
      sessions,
      updateLead: false
    })
  }

  if (eventName === 'SessionStart') {
    // Why: Droid's SessionStart fires while idle (TUI open/resume); wait for real activity before a working row.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  let stateName: 'working' | 'waiting' | 'done' | null = null
  let stoppedByUser = false
  if (needsUserAtToolUse) {
    stateName = 'waiting'
  } else if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    stateName = 'working'
  } else if (eventName === 'Stop') {
    stateName = 'done'
  } else if (eventName === 'Notification' && notification === 'permission') {
    stateName = 'waiting'
  } else if (eventName === 'Notification' && notification === 'idle') {
    // Why: Droid emits no Stop on user-interrupt, only an idle notification when ready again.
    stateName = 'done'
    // Droid sends idle_prompt only when the user stops a turn.
    stoppedByUser = readString(hookPayload, 'notification_type') === 'idle_prompt'
  }
  if (!stateName) {
    return null
  }

  const { sessions } = admission
  if (sessions) {
    applyDroidLeadEvent(sessions, { eventName, stateName, notification })
  }
  const status = sessions ? resolveDroidRowStatus(sessions) : { stateName }
  return buildDroidStatusPayload(state, paneKey, {
    eventName,
    promptText: eventName === 'Notification' ? '' : promptText,
    hookPayload,
    ...status,
    sessions,
    updateLead: true,
    // A stop is recorded only once no child holds the row open.
    verdict:
      stoppedByUser && status.stateName === 'done'
        ? droidVerdictFields('cancellation', Date.now())
        : undefined
  })
}
