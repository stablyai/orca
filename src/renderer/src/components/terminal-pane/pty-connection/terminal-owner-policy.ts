import { shouldSuppressTitleCompletionForFreshHook } from './terminal-title-completion-policy'
import { isClaudeAgent } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry,
  type AgentType
} from '../../../../../shared/agent-status-types'
import { registerAgentHookTerminalLifecycleHandler } from '../agent-hook-terminal-lifecycle'
import type { AgentCompletionStatusSnapshot } from '../agent-completion-coordinator-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'

export function createTerminalOwnerPolicy(services: {
  paneKey: string
  setCacheTimerStartedAt: (paneKey: string, startedAt: number | null) => void
  setFocusReportSuppressionForAgentCompletion: (
    title: string | undefined,
    agent: AgentType | undefined
  ) => void
  queueAgentIdleTerminalModeReset: () => void
  clearFocusReportSuppression: () => void
}) {
  // Compatibility for input cancellation callers; typed command state no longer exists.
  const cancelSuspendedShellCommandInference = (): void => {}
  // Why: a pane-scoped explicit row only counts as current ownership evidence
  // when it is fresh and not already `done` — a stale or completed row is a
  // leftover from a prior agent that may no longer own the shell.
  const isFreshActivePaneAgentEntry = (
    entry: AgentStatusEntry | undefined
  ): entry is AgentStatusEntry => {
    return isFreshNonDoneAgentStatus(entry)
  }
  let pendingSuppressedTitleSideEffects: { title: string; agentType?: AgentType } | null = null
  const clearSuppressedTitleSideEffects = (): void => {
    pendingSuppressedTitleSideEffects = null
  }
  const applyAgentCompletionSideEffects = (
    title: string,
    agentType: AgentType | undefined
  ): void => {
    const settings = useAppStore.getState().settings
    if (
      (agentType === 'claude' || isClaudeAgent(title)) &&
      (settings === null || settings.promptCacheTimerEnabled)
    ) {
      services.setCacheTimerStartedAt(services.paneKey, Date.now())
    }
    services.setFocusReportSuppressionForAgentCompletion(title, agentType)
    services.queueAgentIdleTerminalModeReset()
  }
  const preserveSuppressedTitleSideEffects = (
    title: string,
    activeHookStatus: AgentStatusEntry
  ): void => {
    pendingSuppressedTitleSideEffects = {
      title,
      agentType: activeHookStatus.agentType
    }
    if (activeHookStatus.state === 'waiting' || activeHookStatus.state === 'blocked') {
      services.clearFocusReportSuppression()
      services.queueAgentIdleTerminalModeReset()
    }
  }
  const handleAgentHookTerminalLifecycle = (payload: AgentCompletionStatusSnapshot): void => {
    const pending = pendingSuppressedTitleSideEffects
    if (!pending) {
      return
    }
    const payloadAgentForPending = resolveCompatibleAgentTypeForOwner(
      payload.agentType,
      pending.agentType
    )
    const belongsToPendingAgent =
      !pending.agentType ||
      pending.agentType === 'unknown' ||
      !payload.agentType ||
      payload.agentType === 'unknown' ||
      payloadAgentForPending === pending.agentType
    if (!belongsToPendingAgent || payload.state === 'working') {
      clearSuppressedTitleSideEffects()
      return
    }
    if (payload.state === 'done') {
      applyAgentCompletionSideEffects(pending.title, payload.agentType ?? pending.agentType)
      clearSuppressedTitleSideEffects()
      return
    }
    if (payload.state === 'waiting' || payload.state === 'blocked') {
      services.clearFocusReportSuppression()
      services.queueAgentIdleTerminalModeReset()
    }
  }
  const unregisterAgentHookTerminalLifecycle = registerAgentHookTerminalLifecycleHandler(
    services.paneKey,
    handleAgentHookTerminalLifecycle
  )
  return {
    cancelSuspendedShellCommandInference,
    isFreshActivePaneAgentEntry,
    shouldSuppressTitleCompletionForFreshHook,
    get pendingSuppressedTitleSideEffects() {
      return pendingSuppressedTitleSideEffects
    },
    set pendingSuppressedTitleSideEffects(value: { title: string; agentType?: AgentType } | null) {
      pendingSuppressedTitleSideEffects = value
    },
    clearSuppressedTitleSideEffects,
    applyAgentCompletionSideEffects,
    preserveSuppressedTitleSideEffects,
    handleAgentHookTerminalLifecycle,
    unregisterAgentHookTerminalLifecycle
  }
}
