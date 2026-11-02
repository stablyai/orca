import { detectAgentStatusFromTitle, isClaudeAgent } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry,
  type AgentType
} from '../../../../../shared/agent-status-types'
import { registerAgentHookTerminalLifecycleHandler } from '../agent-hook-terminal-lifecycle'
import type { AgentCompletionStatusSnapshot } from '../agent-completion-coordinator-types'
import {
  resolveCompatibleAgentTypeForOwner,
  shareCompatibleTitleIdentityGroup
} from '../../../../../shared/agent-title-owner'
import { titleShowsNoAgent } from '../../../../../shared/agent-detection'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { retireSupersededHarnessStatus } from './superseded-harness-status'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { recognizeAgentLaunchCommand } from '../../../../../shared/agent-command-line-intent'
import type { TerminalAgent } from '../../../../../shared/terminal-agent'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'

import { MANUAL_AGENT_COMMAND_MAX_CHARS } from './pty-connect-limits'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installCommandInferredPaneAgent(session: ConnectPanePtySession): void {
  // Shadow typed shell commands to infer manual agent launches without launch metadata.
  session.commandInferredPaneAgent = null
  session.pendingShellCommandLine = ''
  session.pendingShellCommandCursor = 0
  session.commandInferredPaneAgentGeneration = 0
  session.shellCommandInferenceSuspendedUntilCommandEnd = false
  session.startAcceptedInferredCommand = (_agent: TerminalAgent): void => {}
  session.requestKnownWindowsShiftEnterReconfirmation = (): void => {}
  session.resetPendingShellCommandLine = (): void => {
    session.pendingShellCommandLine = ''
    session.pendingShellCommandCursor = 0
  }
  session.rememberCommandInferredPaneAgent = (): void => {
    const commandLine = session.pendingShellCommandLine.trim()
    session.resetPendingShellCommandLine()
    const candidateAgent = commandLine
      ? (recognizeAgentLaunchCommand(commandLine)?.agent ?? null)
      : null
    const state = useAppStore.getState()
    const registeredLaunchAgent =
      state.agentLaunchConfigByPaneKey[session.cacheKey]?.identity.agentType
    const foreground = state.paneForegroundAgentByPaneKey[session.cacheKey]
    const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )
    const liveTitle = session.getLivePaneAgentTitle() ?? ''
    // Why: a finished harness leaves launch metadata behind (#24854); shell evidence retires it.
    const paneAtShell =
      foreground?.shellForeground === true ||
      liveTitle.trim().length === 0 ||
      titleShowsNoAgent(liveTitle, tab?.defaultTitle)
    // Why: input inside a live TUI can spell another agent command; a live process read or
    // pane-scoped launch ownership is stronger than typed shell inference.
    const hasStrongerAgentOwnership =
      (foreground?.agentEvidence === 'process-read' &&
        Boolean(foreground.agent) &&
        foreground.shellForeground !== true) ||
      (!paneAtShell && (Boolean(foreground?.agent) || isTuiAgent(registeredLaunchAgent)))
    const nextAgent = hasStrongerAgentOwnership ? null : candidateAgent
    session.commandInferredPaneAgent = nextAgent
    session.commandInferredPaneAgentGeneration += 1
    if (!nextAgent) {
      return
    }
    session.startAcceptedInferredCommand(nextAgent)
    const currentLaunchAgent = tab?.launchAgent ?? registeredLaunchAgent
    let retargetedSingleLeafTab = false
    if (currentLaunchAgent && !shareCompatibleTitleIdentityGroup(nextAgent, currentLaunchAgent)) {
      const layoutRoot = state.terminalLayoutsByTabId[session.deps.tabId]?.root
      // Why: launchAgent is tab-scoped; retargeting it from one split pane would rebrand siblings.
      if (
        isTuiAgent(nextAgent) &&
        layoutRoot?.type === 'leaf' &&
        layoutRoot.leafId === parsePaneKey(session.cacheKey)?.leafId
      ) {
        state.replaceTabLaunchAgent(session.deps.tabId, nextAgent)
        retargetedSingleLeafTab = true
      }
      // Why not re-register: the old harness's resume args must not ride on the new identity.
      state.clearAgentLaunchConfig(session.cacheKey)
    }
    retireSupersededHarnessStatus(session.cacheKey, nextAgent, {
      allowStaleNonDone: paneAtShell && retargetedSingleLeafTab
    })
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
    // Only bare one-column cursor moves preserve the shadow line; modified/parameterized moves require reset to avoid desynchronization.
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
  session.hasFreshPaneAgentSurface = (): boolean => {
    const entry = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    if (session.isFreshActivePaneAgentEntry(entry)) {
      return true
    }
    const liveTitle = session.getLivePaneAgentTitle()
    return detectAgentStatusFromTitle(liveTitle ?? '') !== null
  }
}
