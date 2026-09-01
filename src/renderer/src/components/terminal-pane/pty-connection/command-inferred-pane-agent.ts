import { detectAgentStatusFromTitle, isClaudeAgent } from '@/lib/agent-status'
import { resolvePaneOwnerBaseAgent } from '@/lib/agent-base-identity'
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
import { recognizeAgentProcessFromCommandLine } from '../../../../../shared/agent-process-recognition'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'

import { MANUAL_AGENT_COMMAND_MAX_CHARS } from './pty-connect-limits'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installCommandInferredPaneAgent(session: ConnectPanePtySession): void {
  // Why: infer pane ownership from a manually typed agent command (e.g. `omp`) by
  // shadowing the shell's current command line, for generic terminals where no
  // launch metadata exists. Consumed by getAuthoritativePaneAgent below.
  session.commandInferredPaneAgent = null
  session.pendingShellCommandLine = ''
  session.pendingShellCommandCursor = 0
  session.commandInferredPaneAgentGeneration = 0
  session.shellCommandInferenceSuspendedUntilCommandEnd = false
  session.startAcceptedInferredCommand = (_agent: TuiAgent): void => {}
  session.requestKnownWindowsShiftEnterReconfirmation = (): void => {}
  session.resetPendingShellCommandLine = (): void => {
    session.pendingShellCommandLine = ''
    session.pendingShellCommandCursor = 0
  }
  session.rememberCommandInferredPaneAgent = (): void => {
    const commandLine = session.pendingShellCommandLine.trim()
    session.resetPendingShellCommandLine()
    const candidateAgent = commandLine
      ? (recognizeAgentProcessFromCommandLine(commandLine)?.agent ?? null)
      : null
    const state = useAppStore.getState()
    const registeredLaunchAgent =
      state.agentLaunchConfigByPaneKey[session.cacheKey]?.identity.agentType
    // Why: input inside a live TUI can spell another agent command; process or
    // pane-scoped launch ownership is stronger than typed shell inference.
    const hasStrongerAgentOwnership =
      Boolean(state.paneForegroundAgentByPaneKey[session.cacheKey]?.agent) ||
      isTuiAgent(registeredLaunchAgent)
    const nextAgent = hasStrongerAgentOwnership ? null : candidateAgent
    session.commandInferredPaneAgent = nextAgent
    session.commandInferredPaneAgentGeneration += 1
    if (nextAgent) {
      session.startAcceptedInferredCommand(nextAgent)
    }
  }
  session.clearCommandInferredPaneAgent = (): void => {
    session.commandInferredPaneAgent = null
    session.resetPendingShellCommandLine()
    session.commandInferredPaneAgentGeneration += 1
  }
  session.clearCommandInferredPaneAgentAfterPtySideEffects = (): void => {
    const generation = session.commandInferredPaneAgentGeneration
    session.resetPendingShellCommandLine()
    queueMicrotask(() => {
      setTimeout(() => {
        if (session.commandInferredPaneAgentGeneration === generation) {
          session.clearCommandInferredPaneAgent()
        }
      }, 0)
    })
  }
  session.appendPendingShellCommandInput = (text: string): void => {
    const available = MANUAL_AGENT_COMMAND_MAX_CHARS - session.pendingShellCommandLine.length
    if (available <= 0) {
      session.shellCommandInferenceSuspendedUntilCommandEnd = true
      return
    }
    const inserted = text.slice(0, available)
    session.pendingShellCommandLine =
      session.pendingShellCommandLine.slice(0, session.pendingShellCommandCursor) +
      inserted +
      session.pendingShellCommandLine.slice(session.pendingShellCommandCursor)
    session.pendingShellCommandCursor += inserted.length
    if (inserted.length < text.length) {
      session.shellCommandInferenceSuspendedUntilCommandEnd = true
    }
  }
  session.deletePendingShellCommandWord = (): void => {
    const beforeCursor = session.pendingShellCommandLine.slice(0, session.pendingShellCommandCursor)
    const afterCursor = session.pendingShellCommandLine.slice(session.pendingShellCommandCursor)
    const nextBeforeCursor = beforeCursor.replace(/[^\S\r\n]*\S+[^\S\r\n]*$/, '')
    session.pendingShellCommandLine = nextBeforeCursor + afterCursor
    session.pendingShellCommandCursor = nextBeforeCursor.length
  }
  session.cancelSuspendedShellCommandInference = (): void => {
    if (!session.shellCommandInferenceSuspendedUntilCommandEnd) {
      return
    }
    session.shellCommandInferenceSuspendedUntilCommandEnd = false
    session.resetPendingShellCommandLine()
  }
  session.deletePendingShellCommandCharacter = (): void => {
    if (session.pendingShellCommandCursor === 0) {
      return
    }
    session.pendingShellCommandLine =
      session.pendingShellCommandLine.slice(0, session.pendingShellCommandCursor - 1) +
      session.pendingShellCommandLine.slice(session.pendingShellCommandCursor)
    session.pendingShellCommandCursor -= 1
  }
  session.deletePendingShellCommandCharacterAtCursor = (): void => {
    if (session.pendingShellCommandCursor >= session.pendingShellCommandLine.length) {
      return
    }
    session.pendingShellCommandLine =
      session.pendingShellCommandLine.slice(0, session.pendingShellCommandCursor) +
      session.pendingShellCommandLine.slice(session.pendingShellCommandCursor + 1)
  }
  session.movePendingShellCommandCursor = (delta: number): void => {
    session.pendingShellCommandCursor = Math.min(
      session.pendingShellCommandLine.length,
      Math.max(0, session.pendingShellCommandCursor + delta)
    )
  }
  session.consumeShellCommandCsiSequence = (data: string, index: number): number | null => {
    if (data.charCodeAt(index) !== 0x1b || data[index + 1] !== '[') {
      return null
    }
    let cursor = index + 2
    while (cursor < data.length && /[0-9;?]/.test(data[cursor]!)) {
      cursor += 1
    }
    const final = data[cursor]
    if (!final || !/[~A-Za-z]/.test(final)) {
      return null
    }
    const params = data.slice(index + 2, cursor)
    // Why: only emulate a bare one-column move. Parameterized/modified cursor keys
    // (e.g. Ctrl+Left `\x1b[1;5D` = word-jump) move the real cursor by more than
    // one, so tracking them as ±1 would desync the shadow line — fall through to
    // reset instead of silently corrupting the sampled command.
    if (final === 'D' && params === '') {
      session.movePendingShellCommandCursor(-1)
    } else if (final === 'C' && params === '') {
      session.movePendingShellCommandCursor(1)
    } else if (final === 'H' || (final === '~' && params === '1')) {
      session.pendingShellCommandCursor = 0
    } else if (final === 'F' || (final === '~' && params === '4')) {
      session.pendingShellCommandCursor = session.pendingShellCommandLine.length
    } else if (final === '~' && params === '3') {
      session.deletePendingShellCommandCharacterAtCursor()
    } else if (final === '~' && (params === '200' || params === '201')) {
      // Bracketed paste wrappers are terminal framing, not shell command text.
    } else {
      session.resetPendingShellCommandLine()
    }
    return cursor + 1
  }
  session.getLivePaneAgentTitle = (): string | null => {
    const state = useAppStore.getState()
    const runtimeTitle = state.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const tabTitle = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )?.title
    return runtimeTitle ?? tabTitle ?? null
  }
  // Why: a pane-scoped explicit row only counts as current ownership evidence
  // when it is fresh and not already `done` — a stale or completed row is a
  // leftover from a prior agent that may no longer own the shell.
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
      (resolvePaneOwnerBaseAgent(agentType) === 'claude' || isClaudeAgent(title)) &&
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
  session.hasFreshPaneAgentSurface = (): boolean => {
    const entry = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    if (session.isFreshActivePaneAgentEntry(entry)) {
      return true
    }
    const liveTitle = session.getLivePaneAgentTitle()
    return detectAgentStatusFromTitle(liveTitle ?? '') !== null
  }
}
