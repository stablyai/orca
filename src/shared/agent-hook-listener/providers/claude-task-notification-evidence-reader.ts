import { readClaudeBackgroundAgentTasks } from '../../claude-background-task-inventory'
import {
  readClaudeCurrentTaskNotifications,
  readClaudeTaskTranscriptPosition,
  type ClaudeTaskNotificationTranscriptEvidence
} from '../../claude-task-notification-transcript'
import type { HookListenerState } from '../listener-state'
import { parseAgentHookJson } from '../request-body'
import { readString } from '../tool-input-preview'
import { hasClaudeIdlePromptTaskObservation } from './claude-task-notification-reconciliation'

export async function readClaudeTaskNotificationEvidence(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): Promise<ClaudeTaskNotificationTranscriptEvidence | undefined> {
  const sessionId = readString(hookPayload, 'session_id')
  const transcriptPath = readString(hookPayload, 'transcript_path')
  if (!sessionId || !transcriptPath) {
    return undefined
  }
  const sessionOwner = state.claudeSessionOwnerByPaneKey.get(paneKey)
  if (sessionOwner !== undefined && sessionOwner !== sessionId) {
    return undefined
  }
  if (eventName === 'SubagentStart' && readString(hookPayload, 'agent_id') !== undefined) {
    return {
      position: await readClaudeTaskTranscriptPosition(sessionId, transcriptPath)
    }
  }
  if (
    (eventName === 'Stop' || eventName === 'StopFailure') &&
    readString(hookPayload, 'agent_id') === undefined &&
    readClaudeBackgroundAgentTasks(hookPayload).present
  ) {
    return {
      position: await readClaudeTaskTranscriptPosition(sessionId, transcriptPath)
    }
  }
  if (
    eventName !== 'Notification' ||
    hookPayload['notification_type'] !== 'idle_prompt' ||
    !hasClaudeIdlePromptTaskObservation(state, paneKey, hookPayload)
  ) {
    return undefined
  }
  const observations = state.claudeTaskNotificationState.observationsByPaneKey.get(paneKey)
  if (!observations) {
    return undefined
  }
  const candidates = Array.from(observations.entries()).filter(
    ([, observation]) =>
      observation.transcriptPath === transcriptPath && observation.sessionId === sessionId
  )
  if (candidates.length === 0) {
    return undefined
  }
  return {
    current: await readClaudeCurrentTaskNotifications(sessionId, transcriptPath, candidates)
  }
}

export async function readClaudeTaskNotificationEvidenceFromBody(
  state: HookListenerState,
  body: unknown
): Promise<ClaudeTaskNotificationTranscriptEvidence | undefined> {
  if (!isRecord(body) || typeof body.paneKey !== 'string') {
    return undefined
  }
  const rawPayload = body.payload
  let hookPayload: unknown = rawPayload
  if (typeof rawPayload === 'string') {
    try {
      hookPayload = parseAgentHookJson(rawPayload)
    } catch {
      return undefined
    }
  }
  if (!isRecord(hookPayload)) {
    return undefined
  }
  return readClaudeTaskNotificationEvidence(
    state,
    body.paneKey.trim(),
    hookPayload.hook_event_name,
    hookPayload
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
