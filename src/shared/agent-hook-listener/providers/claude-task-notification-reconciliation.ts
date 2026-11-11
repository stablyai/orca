import type { ClaudeBackgroundAgentTask } from '../../claude-background-task-inventory'
import type {
  ClaudeCurrentTaskNotificationTranscriptRead,
  ClaudeTaskTranscriptPosition,
  ClaudeTaskTranscriptObservation
} from '../../claude-task-notification-transcript'
import { stopClaudeSubagent } from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'

const CLAUDE_TASK_TRANSCRIPT_OBSERVATION_LIMIT = 256

export function recordClaudeSubagentTranscriptObservation(
  state: HookListenerState,
  paneKey: string,
  agentId: string,
  position: ClaudeTaskTranscriptPosition | undefined
): void {
  const observations = getOrCreateObservations(state, paneKey)
  if (position) {
    setObservation(state, paneKey, observations, agentId, 'agent', position)
  } else {
    observations.delete(agentId)
  }
  deleteEmptyObservationMap(state, paneKey, observations)
}

export function recordClaudeStopTranscriptObservations(
  state: HookListenerState,
  paneKey: string,
  tasks: ClaudeBackgroundAgentTask[],
  runningNonAgentTaskIds: string[],
  hasUnidentifiedRunningNonAgentTask: boolean,
  inventoryComplete: boolean,
  position: ClaudeTaskTranscriptPosition | undefined
): void {
  const observations = getOrCreateObservations(state, paneKey)
  if (inventoryComplete) {
    state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
  if (hasUnidentifiedRunningNonAgentTask) {
    state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.add(paneKey)
  }
  const runningIds = new Set<string>()
  for (const task of tasks) {
    if (task.running) {
      runningIds.add(task.id)
      setObservation(state, paneKey, observations, task.id, 'agent', position)
    } else {
      observations.delete(task.id)
    }
  }
  for (const taskId of runningNonAgentTaskIds) {
    runningIds.add(taskId)
    setObservation(state, paneKey, observations, taskId, 'non-agent', position)
  }
  if (inventoryComplete) {
    const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
    for (const [taskId, observation] of observations) {
      if (
        !runningIds.has(taskId) &&
        (observation.kind === 'non-agent' || roster?.get(taskId)?.state !== 'working')
      ) {
        observations.delete(taskId)
      }
    }
  }
  if (observations.size === 0) {
    state.claudeTaskNotificationState.observationsByPaneKey.delete(paneKey)
  }
}

export function forgetClaudeTaskTranscriptObservation(
  state: HookListenerState,
  paneKey: string,
  taskId: string
): void {
  const observations = state.claudeTaskNotificationState.observationsByPaneKey.get(paneKey)
  observations?.delete(taskId)
  if (observations?.size === 0) {
    state.claudeTaskNotificationState.observationsByPaneKey.delete(paneKey)
  }
}

export function reconcileClaudeIdlePromptTasks(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  transcript: ClaudeCurrentTaskNotificationTranscriptRead | undefined
): boolean {
  const transcriptPath = readString(hookPayload, 'transcript_path')
  const sessionId = readString(hookPayload, 'session_id')
  const observations = state.claudeTaskNotificationState.observationsByPaneKey.get(paneKey)
  if (!transcript?.available || !observations || !transcriptPath || !sessionId) {
    return false
  }
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (roster && roster.size > CLAUDE_TASK_TRANSCRIPT_OBSERVATION_LIMIT) {
    return false
  }
  if (
    state.claudeSessionOwnerByPaneKey.get(paneKey) !== undefined &&
    state.claudeSessionOwnerByPaneKey.get(paneKey) !== sessionId
  ) {
    return false
  }
  const candidates = Array.from(observations.entries()).filter(
    ([, observation]) =>
      observation.transcriptPath === transcriptPath && observation.sessionId === sessionId
  )
  const matching = candidates.filter(
    ([, observation]) => observation.fileIdentity === transcript.fileIdentity
  )
  if (matching.length === 0) {
    return false
  }
  const terminalNotificationOffsets = new Map<string, number>()
  for (const notification of transcript.notifications) {
    terminalNotificationOffsets.set(notification.taskId, notification.byteOffset)
  }
  const terminalTaskIds = new Set<string>()
  const terminalTaskKinds = new Map<string, ClaudeTaskTranscriptObservation['kind']>()
  for (const [taskId, observation] of matching) {
    const notificationOffset = terminalNotificationOffsets.get(taskId)
    if (notificationOffset !== undefined && notificationOffset >= observation.byteOffset) {
      observations.delete(taskId)
      terminalTaskIds.add(taskId)
      terminalTaskKinds.set(taskId, observation.kind)
    }
  }
  if (terminalTaskIds.size === 0) {
    return false
  }
  if (roster) {
    for (const taskId of terminalTaskIds) {
      if (terminalTaskKinds.get(taskId) === 'agent') {
        stopClaudeSubagent(roster, taskId)
      }
    }
    if (roster.size === 0) {
      state.claudeSubagentRosterByPaneKey.delete(paneKey)
    }
  }
  if (observations.size === 0) {
    state.claudeTaskNotificationState.observationsByPaneKey.delete(paneKey)
  }
  updateNonAgentTaskGate(state, paneKey, observations)
  return true
}

export function hasClaudeIdlePromptTaskObservation(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): boolean {
  const transcriptPath = readString(hookPayload, 'transcript_path')
  const sessionId = readString(hookPayload, 'session_id')
  const observations = state.claudeTaskNotificationState.observationsByPaneKey.get(paneKey)
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (
    !transcriptPath ||
    !sessionId ||
    !observations ||
    (roster && roster.size > CLAUDE_TASK_TRANSCRIPT_OBSERVATION_LIMIT) ||
    (state.claudeSessionOwnerByPaneKey.get(paneKey) !== undefined &&
      state.claudeSessionOwnerByPaneKey.get(paneKey) !== sessionId)
  ) {
    return false
  }

  for (const observation of observations.values()) {
    if (observation.transcriptPath === transcriptPath && observation.sessionId === sessionId) {
      return true
    }
  }
  return false
}

function getOrCreateObservations(
  state: HookListenerState,
  paneKey: string
): Map<string, ClaudeTaskTranscriptObservation> {
  let observations = state.claudeTaskNotificationState.observationsByPaneKey.get(paneKey)
  if (!observations) {
    observations = new Map()
    state.claudeTaskNotificationState.observationsByPaneKey.set(paneKey, observations)
  }
  return observations
}

function setObservation(
  state: HookListenerState,
  paneKey: string,
  observations: Map<string, ClaudeTaskTranscriptObservation>,
  taskId: string,
  kind: ClaudeTaskTranscriptObservation['kind'],
  position: ClaudeTaskTranscriptPosition | undefined
): void {
  if (
    position &&
    (observations.has(taskId) || observations.size < CLAUDE_TASK_TRANSCRIPT_OBSERVATION_LIMIT)
  ) {
    observations.set(taskId, { ...position, kind })
  } else if (kind === 'non-agent') {
    state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.add(paneKey)
    observations.delete(taskId)
  } else if (!position) {
    observations.delete(taskId)
  }
}

function deleteEmptyObservationMap(
  state: HookListenerState,
  paneKey: string,
  observations: Map<string, ClaudeTaskTranscriptObservation>
): void {
  if (observations.size === 0) {
    state.claudeTaskNotificationState.observationsByPaneKey.delete(paneKey)
  }
}

function updateNonAgentTaskGate(
  state: HookListenerState,
  paneKey: string,
  observations: Map<string, ClaudeTaskTranscriptObservation>
): void {
  const hasRunningTask =
    state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.has(paneKey) ||
    Array.from(observations.values()).some((observation) => observation.kind === 'non-agent')
  if (hasRunningTask) {
    state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
  } else {
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
}
