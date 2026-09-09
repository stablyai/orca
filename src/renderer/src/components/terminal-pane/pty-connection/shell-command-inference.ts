import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { AGENT_INTERRUPT_SETTLE_MS } from '../../../../../shared/agent-interrupt-intent'
import { resolvePaneAgentOwner } from '../../../../../shared/pane-agent-owner'

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
  /**
   * Resolves the authoritative owner agent type for this pane, checking tab launch,
   * pane startup, typed command ownership, and store state configuration.
   *
   * Why: launch ownership wins so Pi-compatible live titles/hooks can't repaint an
   * OMP-owned pane back to Pi; command ownership covers manually typed `omp`
   * in generic terminals where launch metadata does not exist.
   */
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
  // Why: the renderer veto (owner evidence beating a Gemini-looking title) must
  // use only pane-scoped, CURRENT ownership. getAuthoritativePaneAgent leads
  // with the tab-shared `tab.launchAgent` and a never-cleared
  // `paneStartup.launchAgent`, which would let a sibling split pane or a reused
  // pane keep WebGL for a genuine Gemini terminal (#7428 regression class).
  // Launch identity is excluded, and the never-clearing startup seed
  // (`paneStartup.initialAgentStatus`) too; a stale or `done` explicit row is
  // ignored via the freshness predicate so a reused pane cannot inherit a prior
  // agent's veto. Only live foreground command inference and a fresh, active
  // hook row count. A genuine OMP/Pi pane stays protected owner-independently by
  // the isPiAgentTitle guard inside isGeminiTerminalTitle.
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
    const title = currentTitle ?? statusTitle
    if (!title) {
      return
    }
    const neutralTitle = session.neutralTerminalTitle()
    // Why: inferred interrupts update the explicit hook row, but many CLIs leave
    // their OSC title stuck on a working spinner. Replace only this fallback
    // title signal with a neutral terminal label so the existing process tracker
    // can still decide whether an agent TUI is truly alive.
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
  // Why: post-parse veto callbacks must only judge the latest replay frame; a
  // newer frame bumps the generation so a stale callback stands down.
  session.reattachReplayPayloadSignalGeneration = 0
  session.rememberReattachPayloadAgentSignal = (
    data: string,
    opts: { fullScreenReplay: boolean }
  ): void => {
    session.reattachReplayPayloadSignalGeneration += 1
    // Why: ordinary scrollback can mention agent names. Treat replay bytes as
    // a live Cursor Agent signal only when they look like its restored screen.
    const signal = hasCursorAgentReattachPayloadScreenSignal(data)
    // Why: incremental (non-clearing) replay frames repaint only part of the
    // screen, so their bytes can only add evidence — a full-screen replay is
    // the authoritative repaint that may clear the flag.
    session.reattachReplayPayloadHasCursorAgentSignal = opts.fullScreenReplay
      ? signal
      : session.reattachReplayPayloadHasCursorAgentSignal || signal
  }
  session.isCursorAgentNativeTitle = (title: string): boolean => {
    return title.trim().toLowerCase() === CURSOR_AGENT_REATTACH_HEADER.toLowerCase()
  }
  session.hasLiveAgentReattachStatusOrTitleSignal = (): boolean => {
    // Why: launch ownership (tab.launchAgent) never decays after the agent
    // exits, so it must not count as liveness here — only live status, live
    // titles, and the replayed screen shape do.
    if (useAppStore.getState().agentStatusByPaneKey[session.cacheKey]) {
      return true
    }
    const title = session.getCurrentTerminalTitle() ?? ''
    // Why: broad token matching (getAgentLabel) fires on titles like
    // "ssh devin@host"; that surface is too loose to gate mode preservation
    // and PTY byte injection, so only exact/status titles count here.
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
