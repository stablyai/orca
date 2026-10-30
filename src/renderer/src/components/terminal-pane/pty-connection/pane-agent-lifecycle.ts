import { detectAgentStatusFromTitle, isClaudeAgent } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry,
  type AgentType
} from '../../../../../shared/agent-status-types'
import { registerAgentHookTerminalLifecycleHandler } from '../agent-hook-terminal-lifecycle'
import type { AgentCompletionStatusSnapshot } from '../agent-completion-coordinator-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPaneAgentLifecycle(session: ConnectPanePtySession): void {
  // Only fresh, unfinished pane rows prove current ownership; stale/completed rows can belong to a previous agent.
  session.isFreshActivePaneAgentEntry = (
    entry: AgentStatusEntry | undefined
  ): entry is AgentStatusEntry => {
    return isFreshNonDoneAgentStatus(entry)
  }
  session.shouldSuppressTitleCompletionForFreshHook = (
    title: string,
    activeHookStatus: AgentStatusEntry | undefined
  ): boolean => {
    if (
      detectAgentStatusFromTitle(title) === 'working' ||
      !isFreshNonDoneAgentStatus(activeHookStatus)
    ) {
      return false
    }
    const explicitTitleAgentType = resolveCommittedTitleAgentType(title)
    const activeHookAgentForTitle = resolveCompatibleAgentTypeForOwner(
      activeHookStatus?.agentType,
      explicitTitleAgentType
    )
    const titleNamesDifferentKnownAgent =
      explicitTitleAgentType &&
      activeHookStatus?.agentType &&
      activeHookStatus.agentType !== 'unknown' &&
      activeHookAgentForTitle !== explicitTitleAgentType
    return !titleNamesDifferentKnownAgent
  }
  session.pendingSuppressedTitleSideEffects = null
  session.clearSuppressedTitleSideEffects = (): void => {
    session.pendingSuppressedTitleSideEffects = null
  }
  session.applyAgentCompletionSideEffects = (
    title: string,
    agentType: AgentType | undefined
  ): void => {
    const settings = useAppStore.getState().settings
    if (
      (agentType === 'claude' || isClaudeAgent(title)) &&
      (settings === null || settings.promptCacheTimerEnabled)
    ) {
      session.deps.setCacheTimerStartedAt(session.cacheKey, Date.now())
    }
    session.setFocusReportSuppressionForAgentCompletion(title, agentType)
    session.queueAgentIdleTerminalModeReset()
  }
  session.preserveSuppressedTitleSideEffects = (
    title: string,
    activeHookStatus: AgentStatusEntry
  ): void => {
    session.pendingSuppressedTitleSideEffects = {
      title,
      agentType: activeHookStatus.agentType
    }
    if (activeHookStatus.state === 'waiting' || activeHookStatus.state === 'blocked') {
      session.suppressNativeWindowsIdleCodexFocusReports = false
      session.queueAgentIdleTerminalModeReset()
    }
  }
  session.handleAgentHookTerminalLifecycle = (payload: AgentCompletionStatusSnapshot): void => {
    const pending = session.pendingSuppressedTitleSideEffects
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
      session.clearSuppressedTitleSideEffects()
      return
    }
    if (payload.state === 'done') {
      session.applyAgentCompletionSideEffects(pending.title, payload.agentType ?? pending.agentType)
      session.clearSuppressedTitleSideEffects()
      return
    }
    if (payload.state === 'waiting' || payload.state === 'blocked') {
      session.suppressNativeWindowsIdleCodexFocusReports = false
      session.queueAgentIdleTerminalModeReset()
    }
  }
  session.unregisterAgentHookTerminalLifecycle = registerAgentHookTerminalLifecycleHandler(
    session.cacheKey,
    session.handleAgentHookTerminalLifecycle
  )
}
