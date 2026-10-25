import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import { isAgentStatusHeldOpenByChildWork } from '../../agent-lead-status-fold'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { readClaudeBackgroundAgentTasks } from '../../claude-background-task-inventory'
import {
  claudeRosterHasRestoredSnapshotSubagent,
  claudeRosterHasRuntimeWorkingSubagent,
  foldClaudeBackgroundTasksIntoRoster,
  isClaudeChildTurnEndEvent,
  reapUnconfirmedRestoredClaudeSubagents,
  upsertWorkingClaudeSubagent
} from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { readFirstString } from '../interactive-tool'
import { shouldIgnoreCompactContinuationUserPromptSubmit } from '../prompt-fields'
import { readString } from '../tool-input-preview'
import {
  buildClaudeCachedLeadStatusPayload,
  normalizeClaudeSubagentLifecycleEvent
} from './claude-lifecycle-events'
import {
  getOrCreateClaudeSubagentRoster,
  resolveClaudePaneStatus,
  setClaudeMainAgentTurnState,
  updateClaudeRunningNonAgentTask,
  voidClaimsOfReplacedClaudeSession
} from './claude-roster-state'
import {
  claudePaneHasRunningChildWork,
  claudeRowHasUnlistedLiveWork
} from './claude-pane-hold-evidence'
import { buildClaudeStatusPayload } from './claude-status-build'
import { trackClaudeTaskNotificationDelivery } from './claude-task-notification-delivery'
import { recordClaudeTeammateSpawn } from './claude-teammate-spawn'

const CLAUDE_HOOK_AGENT_ID_PREFIX = 'hook-agent-'

export function normalizeClaudeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const eventAgentId = readString(hookPayload, 'agent_id')
  if (
    eventName === 'SubagentStart' ||
    eventName === 'TeammateIdle' ||
    isClaudeChildTurnEndEvent(eventName, eventAgentId)
  ) {
    return normalizeClaudeSubagentLifecycleEvent(state, eventName, paneKey, hookPayload)
  }
  voidClaimsOfReplacedClaudeSession(state, eventName, eventAgentId, paneKey, hookPayload)
  if (eventName === 'SessionStart') {
    // SessionStart supplies resume identity before prompts; mark idle/sessionBoundary to avoid phantom work/completion notifications (STA-3386).
    const sessionStartSource = hookPayload['source']
    if (
      eventAgentId !== undefined ||
      (sessionStartSource !== 'startup' &&
        sessionStartSource !== 'resume' &&
        sessionStartSource !== 'clear')
    ) {
      // Only known idle sources qualify; compact restarts and child SessionStart cannot settle a live lead.
      return null
    }
    // New sessions must not inherit old child/task/cron gates.
    state.claudeSubagentRosterByPaneKey.delete(paneKey)
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
    state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    state.claudeLaunchedBackgroundTasksByPaneKey.delete(paneKey)
    // New sessions start a new main-agent clock.
    setClaudeMainAgentTurnState(state, paneKey, { state: 'done', stateStartedAt: Date.now() })
    return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
      stateName: 'done',
      updateToolSnapshot: true,
      sessionBoundary: true
    })
  }
  const previousLead = state.claudeLeadStateByPaneKey.get(paneKey)
  // Only Stop/StopFailure carries a turn verdict; cancellation never retires surviving shell/cron/subagent work.
  const isTurnBoundary = eventName === 'Stop' || eventName === 'StopFailure'
  // Plain Stop has unknown outcome. Carry inferred cancellation; is_interrupt remains a secondary source for supporting builds.
  const outcome = !isTurnBoundary
    ? undefined
    : (eventAgentId === undefined && hookPayload['is_interrupt'] === true) ||
        previousLead?.outcome === 'cancellation'
      ? ('cancellation' as const)
      : eventName === 'StopFailure'
        ? ('failure' as const)
        : undefined
  const backgroundTasks = readClaudeBackgroundAgentTasks(hookPayload)
  const isTaskWakeup =
    eventAgentId === undefined &&
    trackClaudeTaskNotificationDelivery(state, paneKey, eventName, hookPayload, backgroundTasks)
  if (eventName === 'PostToolUse' && eventAgentId === undefined) {
    recordClaudeTeammateSpawn(state, paneKey, hookPayload)
  }
  const sessionCrons = hookPayload['session_crons']
  const sessionCronInventoryPresent = Array.isArray(sessionCrons)
  const hasActiveSessionCron = sessionCronInventoryPresent && sessionCrons.length > 0

  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  // AskUserQuestion blocks on PreToolUse as well as PermissionRequest; both need human attention.
  const eventToolName = readString(hookPayload, 'tool_name')
  const isAskUserQuestionWait =
    (eventName === 'PreToolUse' || eventName === 'PermissionRequest') &&
    isAskUserQuestionTool(eventToolName)
  const isAskUserQuestion = eventName === 'PreToolUse' && isAskUserQuestionWait
  // Manual PostCompact ends at idle without Stop; auto compaction stays in-turn, and PreCompact alone can be aborted (STA-2915).
  const isManualCompactCompletion = eventName === 'PostCompact' && hookPayload.trigger === 'manual'
  const reportedStateName =
    eventName === 'UserPromptSubmit' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure' ||
    (eventName === 'PreToolUse' && !isAskUserQuestion)
      ? 'working'
      : eventName === 'PermissionRequest' || isAskUserQuestion
        ? 'waiting'
        : isTurnBoundary || isManualCompactCompletion
          ? 'done'
          : null

  if (!reportedStateName) {
    return null
  }
  if (backgroundTasks.present && eventAgentId === undefined) {
    updateClaudeRunningNonAgentTask(state, paneKey, backgroundTasks.hasRunningNonAgentTask)
  }
  if (sessionCronInventoryPresent && eventAgentId === undefined) {
    if (hasActiveSessionCron) {
      state.claudeActiveSessionCronPaneKeys.add(paneKey)
    } else {
      state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    }
  } else if (eventAgentId === undefined && isTurnBoundary && backgroundTasks.present) {
    // Why: current Claude may omit an empty cron inventory while still emitting background_tasks.
    state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  }

  const eventToolUseId = readFirstString(hookPayload, ['tool_use_id', 'toolUseId'])
  const previousTool = state.lastToolByPaneKey.get(paneKey)
  const isParallelSiblingCompletionDuringQuestion =
    eventAgentId === undefined &&
    previousLead?.state === 'waiting' &&
    isAskUserQuestionTool(previousTool?.toolName) &&
    (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') &&
    previousLead.waitingToolUseId !== undefined &&
    eventToolUseId !== undefined &&
    eventToolUseId !== previousLead.waitingToolUseId
  if (isParallelSiblingCompletionDuringQuestion) {
    return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload)
  }

  // Child tools update their roster only, except child-induced waits and that child's next activity clearing its wait.
  const isWaitingInducing = reportedStateName === 'waiting'
  const subagentOriginId =
    !isWaitingInducing &&
    (eventName === 'PreToolUse' ||
      eventName === 'PostToolUse' ||
      eventName === 'PostToolUseFailure')
      ? eventAgentId
      : undefined
  // Why: `"type": "agent"` hook runs emit tool hooks (agent_type only if inherited) but never SubagentStop, so their row would stay working forever; real children may be untyped and start-less.
  const isClaudeHookAgent = eventAgentId?.startsWith(CLAUDE_HOOK_AGENT_ID_PREFIX) === true
  if (eventAgentId && (subagentOriginId || isWaitingInducing) && !isClaudeHookAgent) {
    upsertWorkingClaudeSubagent(
      getOrCreateClaudeSubagentRoster(state, paneKey),
      eventAgentId,
      { agentType: readString(hookPayload, 'agent_type') },
      Date.now()
    )
  }
  if (subagentOriginId) {
    const lead = state.claudeLeadStateByPaneKey.get(paneKey)
    if (lead?.state !== 'waiting' || lead.waitingAgentId !== subagentOriginId) {
      return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload, {
        workingChildEvidence: true
      })
    }
    const isParallelSiblingCompletionDuringChildQuestion =
      (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') &&
      lead.waitingToolUseId !== undefined &&
      eventToolUseId !== undefined &&
      eventToolUseId !== lead.waitingToolUseId
    if (isParallelSiblingCompletionDuringChildQuestion) {
      return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload, {
        workingChildEvidence: true
      })
    }
    // Approval clears the card and restores the displaced lead; inventing working cannot later fold back to done.
    const restored = setClaudeMainAgentTurnState(
      state,
      paneKey,
      lead.stateBeforeWait ?? { state: 'working' as const }
    )
    return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
      ...resolveClaudePaneStatus(state, paneKey, restored),
      updateToolSnapshot: true
    })
  }

  // Even untracked children cannot own lead state/background evidence.
  if (eventAgentId && !isWaitingInducing) {
    return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload, {
      workingChildEvidence: claudeRosterHasRuntimeWorkingSubagent(
        state.claudeSubagentRosterByPaneKey.get(paneKey)
      )
    })
  }

  if (isTurnBoundary && eventAgentId === undefined) {
    // Teammates can report running while idle; trust only unambiguous background_tasks entries and retain tracking for older builds.
    if (backgroundTasks.present) {
      foldClaudeBackgroundTasksIntoRoster(
        getOrCreateClaudeSubagentRoster(state, paneKey),
        backgroundTasks.tasks,
        Date.now(),
        { inventoryComplete: !backgroundTasks.truncated }
      )
    }
  }
  // Preserve the original lead stash through multiple child waits.
  const stateBeforeWait =
    isWaitingInducing && eventAgentId && previousLead
      ? previousLead.state === 'waiting'
        ? previousLead.stateBeforeWait
        : {
            state: previousLead.state,
            // Child waits must retain the lead's verdict and clock.
            ...(previousLead.outcome ? { outcome: previousLead.outcome } : {}),
            stateStartedAt: previousLead.stateStartedAt,
            ...(previousLead.taskWakeupTurn ? { taskWakeupTurn: true as const } : {}),
            // Keep the displaced lead end time so later child drain belongs to the same turn.
            ...(previousLead.turnCompletedAt !== undefined
              ? { turnCompletedAt: previousLead.turnCompletedAt }
              : {})
          }
      : undefined
  const waitingToolUseId = eventToolUseId ?? previousLead?.waitingToolUseId

  if (isManualCompactCompletion) {
    // Manual compact invalidates snapshot-only child liveness; confirmed children/shells/crons still hold the pane (STA-2915).
    const restoredRoster = state.claudeSubagentRosterByPaneKey.get(paneKey)
    if (
      restoredRoster &&
      reapUnconfirmedRestoredClaudeSubagents(restoredRoster) &&
      restoredRoster.size === 0
    ) {
      state.claudeSubagentRosterByPaneKey.delete(paneKey)
    }
  }

  const taskWakeupTurn =
    eventName === 'UserPromptSubmit'
      ? isTaskWakeup
      : !isTurnBoundary && !isManualCompactCompletion && previousLead?.taskWakeupTurn === true
  const resolvedStatus = resolveClaudePaneStatus(state, paneKey, {
    state: reportedStateName,
    ...(taskWakeupTurn ? { taskWakeupTurn: true as const } : {})
  })
  // Reuse resolved state for compact ownership instead of folding twice (#15202).
  const effectiveState = resolvedStatus.stateName
  // Pin held turn identity by end time for later all-clear pairing; cancelled turns earn no completion stamp.
  const turnCompletedAt =
    eventAgentId === undefined &&
    isTurnBoundary &&
    outcome !== 'cancellation' &&
    isAgentStatusHeldOpenByChildWork({
      state: resolvedStatus.stateName,
      mainAgent: { state: reportedStateName }
    }) &&
    // Owed notifications wake the lead within ~100ms; announcing first would duplicate completion.
    claudePaneHasRunningChildWork(state, paneKey)
      ? Date.now()
      : undefined

  setClaudeMainAgentTurnState(state, paneKey, {
    state: reportedStateName,
    ...(taskWakeupTurn ? { taskWakeupTurn: true as const } : {}),
    ...(outcome ? { outcome } : {}),
    ...(isWaitingInducing && eventAgentId ? { waitingAgentId: eventAgentId } : {}),
    ...(isAskUserQuestionWait && waitingToolUseId !== undefined ? { waitingToolUseId } : {}),
    ...(stateBeforeWait ? { stateBeforeWait } : {}),
    ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {})
  })

  const effectiveRoster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (
    isTurnBoundary &&
    eventAgentId === undefined &&
    resolvedStatus.stateName === 'working' &&
    claudeRosterHasRestoredSnapshotSubagent(effectiveRoster) &&
    !claudeRosterHasRuntimeWorkingSubagent(effectiveRoster) &&
    !claudeRowHasUnlistedLiveWork(state, paneKey)
  ) {
    // Legacy/partial Stop confirms lead only; snapshot children remain unconfirmed.
    state.claudeUnconfirmedRestoredStatusPaneKeys.add(paneKey)
  }

  if (isManualCompactCompletion && effectiveState !== 'done') {
    // Compact clears or stays silent; live work must not gain a fresh clock or lose restoredUnconfirmed from an unrelated compact.
    return null
  }

  return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
    ...resolvedStatus,
    updateToolSnapshot: true,
    // Compact is a session boundary, never work eligible for completion notifications/automation.
    sessionBoundary: isManualCompactCompletion ? true : undefined
  })
}
