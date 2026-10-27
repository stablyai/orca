import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { AGENT_INTERRUPT_SETTLE_MS } from '../../../../../shared/agent-interrupt-intent'
import { resolvePaneAgentOwner } from '../../../../../shared/pane-agent-owner'
import { titleAfterInferredInterrupt } from '../../../../../shared/terminal-pane-title-reset'

import { MANUAL_AGENT_COMMAND_MAX_CHARS } from './pty-connect-limits'
import {
  CURSOR_AGENT_REATTACH_HEADER,
  terminalOwnsDomFocus,
  hasCursorAgentReattachPayloadScreenSignal
} from './cursor-agent-reattach-screen'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installShellCommandInference(session: ConnectPanePtySession): void {
  session.observeAcceptedShellCommandInput = (data: string): void => {
    if (
      data.includes('\r') ||
      data.includes('\n') ||
      data.includes('\x03') ||
      data.includes('\x04')
    ) {
      // Why: shells without OSC 133 give no command/exit boundary. An accepted
      // submit or interrupt revokes stale trusted Shift+Enter routing and confirms once.
      session.requestKnownWindowsShiftEnterReconfirmation()
    }
    if (session.commandInferredPaneAgent) {
      return
    }
    // Why: bytes typed inside a live agent TUI are prompt text, not shell
    // commands, even if they spell another agent binary name.
    if (session.hasFreshPaneAgentSurface()) {
      session.resetPendingShellCommandLine()
      return
    }
    if (session.shellCommandInferenceSuspendedUntilCommandEnd) {
      if (data.includes('\x03') || data.includes('\x15')) {
        session.shellCommandInferenceSuspendedUntilCommandEnd = false
        session.resetPendingShellCommandLine()
      }
      if (data.includes('\r') || data.includes('\n')) {
        session.shellCommandInferenceSuspendedUntilCommandEnd = false
      }
      return
    }
    if (data.length > MANUAL_AGENT_COMMAND_MAX_CHARS) {
      session.resetPendingShellCommandLine()
      session.shellCommandInferenceSuspendedUntilCommandEnd =
        !data.includes('\r') && !data.includes('\n')
      return
    }
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]!
      if (char === '\r' || char === '\n') {
        session.shellCommandInferenceSuspendedUntilCommandEnd = false
        session.rememberCommandInferredPaneAgent()
        if (session.commandInferredPaneAgent) {
          return
        }
        continue
      }
      if (char === '\x7f' || char === '\b') {
        session.deletePendingShellCommandCharacter()
        continue
      }
      if (char === '\x17') {
        session.deletePendingShellCommandWord()
        continue
      }
      if (char === '\x03' || char === '\x15') {
        session.resetPendingShellCommandLine()
        continue
      }
      if (char === '\x1b') {
        const nextIndex = session.consumeShellCommandCsiSequence(data, index)
        if (nextIndex !== null) {
          index = nextIndex - 1
          continue
        }
        session.resetPendingShellCommandLine()
        continue
      }
      if (char < ' ') {
        session.resetPendingShellCommandLine()
        continue
      }
      if (char >= ' ') {
        session.appendPendingShellCommandInput(char)
        if (session.shellCommandInferenceSuspendedUntilCommandEnd) {
          return
        }
      }
    }
  }
  /** Launch ownership preserves OMP over Pi-compatible titles/hooks; typed command ownership covers manual launches without metadata. */
  session.getAuthoritativePaneAgent = (): AgentType | undefined => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )
    return (
      resolvePaneAgentOwner({
        launchAgent: tab?.launchAgent,
        startupLaunchAgent: session.paneStartup?.launchAgent,
        initialStatusAgent: session.paneStartup?.initialAgentStatus?.agent,
        commandInferredAgent: session.commandInferredPaneAgent,
        hookAgent: state.agentStatusByPaneKey[session.cacheKey]?.agentType
      }) ?? undefined
    )
  }
  // GPU veto needs current pane evidence: tab-shared/never-cleared launch seeds can describe siblings or dead agents. Use fresh active rows or command evidence; Pi/OMP titles retain their own guard (#7428).
  session.getPaneScopedRendererOwner = (): AgentType | undefined => {
    const entry = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    return (
      session.commandInferredPaneAgent ??
      (session.isFreshActivePaneAgentEntry(entry) ? entry.agentType : undefined)
    )
  }
  session.clearInferredInterruptWorkingTitle = (): void => {
    const state = useAppStore.getState()
    const currentTitle = state.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const statusTitle = state.agentStatusByPaneKey[session.cacheKey]?.terminalTitle
    const neutralTitle = titleAfterInferredInterrupt(
      currentTitle ?? statusTitle,
      session.neutralTerminalTitle()
    )
    if (neutralTitle === null) {
      return
    }
    // After inferred interrupt, clear only stale working-title fallback; process tracking still decides whether the TUI lives.
    session.deps.setRuntimePaneTitle(session.deps.tabId, session.pane.id, neutralTitle)
    if (session.manager.getActivePane()?.id === session.pane.id) {
      session.deps.updateTabTitle(session.deps.tabId, neutralTitle)
    }
  }
  session.titleOnlyInterruptTimer = null
  session.clearTitleOnlyInterruptTimer = (): void => {
    if (session.titleOnlyInterruptTimer !== null) {
      clearTimeout(session.titleOnlyInterruptTimer)
      session.titleOnlyInterruptTimer = null
    }
  }
  session.observeTitleOnlyInterrupt = (): void => {
    const state = useAppStore.getState()
    if (state.agentStatusByPaneKey[session.cacheKey]) {
      return
    }
    const runtimeTitle = state.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const tabTitle = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )?.title
    const baselineTitle = runtimeTitle ?? tabTitle
    if (detectAgentStatusFromTitle(baselineTitle ?? '') !== 'working') {
      return
    }
    session.clearTitleOnlyInterruptTimer()
    session.titleOnlyInterruptTimer = setTimeout(() => {
      session.titleOnlyInterruptTimer = null
      if (useAppStore.getState().agentStatusByPaneKey[session.cacheKey]) {
        return
      }
      const currentState = useAppStore.getState()
      const currentRuntimeTitle =
        currentState.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
      const currentTabTitle = (currentState.tabsByWorktree[session.deps.worktreeId] ?? []).find(
        (entry) => entry.id === session.deps.tabId
      )?.title
      const currentTitle = currentRuntimeTitle ?? currentTabTitle
      if (
        currentTitle === baselineTitle &&
        detectAgentStatusFromTitle(currentTitle ?? '') === 'working'
      ) {
        // Why: title-only agents such as Pi can miss their own idle title after
        // Ctrl+C. Clear only an unchanged, acknowledged working title.
        session.clearInferredInterruptWorkingTitle()
      }
    }, AGENT_INTERRUPT_SETTLE_MS)
  }
  session.clearReattachIdleAgentCursorResetTimer = (): void => {
    if (session.reattachIdleAgentCursorResetTimer !== null) {
      clearTimeout(session.reattachIdleAgentCursorResetTimer)
      session.reattachIdleAgentCursorResetTimer = null
    }
  }
  session.getCurrentTerminalTitle = (): string | null => {
    const state = useAppStore.getState()
    const runtimeTitle = state.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const tabTitle = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )?.title
    return runtimeTitle ?? tabTitle ?? null
  }
  session.reattachReplayPayloadHasCursorAgentSignal = false
  // Only the latest replay generation may judge post-parse agent-screen evidence.
  session.reattachReplayPayloadSignalGeneration = 0
  session.rememberReattachPayloadAgentSignal = (
    data: string,
    opts: { fullScreenReplay: boolean }
  ): void => {
    session.reattachReplayPayloadSignalGeneration += 1
    // Agent names in history are not liveness; require restored Cursor screen shape.
    const signal = hasCursorAgentReattachPayloadScreenSignal(data)
    // Incremental frames may add evidence; only authoritative full-screen repaint may clear it.
    session.reattachReplayPayloadHasCursorAgentSignal = opts.fullScreenReplay
      ? signal
      : session.reattachReplayPayloadHasCursorAgentSignal || signal
  }
  session.isCursorAgentNativeTitle = (title: string): boolean => {
    return title.trim().toLowerCase() === CURSOR_AGENT_REATTACH_HEADER.toLowerCase()
  }
  session.hasLiveAgentReattachStatusOrTitleSignal = (): boolean => {
    // Permanent tab launch metadata cannot prove liveness; require current status/title or restored screen shape.
    if (useAppStore.getState().agentStatusByPaneKey[session.cacheKey]) {
      return true
    }
    const title = session.getCurrentTerminalTitle() ?? ''
    // Loose label matching can classify ssh user names; mode preservation and input injection need exact/status titles.
    return detectAgentStatusFromTitle(title) !== null || session.isCursorAgentNativeTitle(title)
  }
  session.hasLiveAgentReattachSignal = (): boolean => {
    return (
      session.hasLiveAgentReattachStatusOrTitleSignal() ||
      session.reattachReplayPayloadHasCursorAgentSignal
    )
  }
  session.shouldPreserveAgentReattachModes = (): boolean => {
    // Why: ordinary shells can inherit stale ?25l/?1004h from replay bytes.
    // Preserve those modes only when reattach still looks agent-owned.
    return session.hasLiveAgentReattachSignal()
  }
  session.shouldSendFocusedAgentReattachFocusIn = (): boolean => {
    return terminalOwnsDomFocus(session.pane.terminal) && session.shouldPreserveAgentReattachModes()
  }
}
