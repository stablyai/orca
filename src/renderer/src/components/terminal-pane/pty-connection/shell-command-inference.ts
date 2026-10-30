import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { AGENT_INTERRUPT_SETTLE_MS } from '../../../../../shared/agent-interrupt-intent'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { titleAfterInferredInterrupt } from '../../../../../shared/terminal-pane-title-reset'

import {
  CURSOR_AGENT_REATTACH_HEADER,
  terminalOwnsDomFocus,
  hasCursorAgentReattachPayloadScreenSignal
} from './cursor-agent-reattach-screen'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installShellCommandInference(session: ConnectPanePtySession): void {
  // Temporary input-forwarder seam; its owner removes this call with the next ownership rewrite.
  session.cancelSuspendedShellCommandInference = (): void => {}
  session.observeAcceptedShellCommandInput = (data: string): void => {
    const submitted = data.includes('\r') || data.includes('\n')
    if (!submitted && !data.includes('\x03') && !data.includes('\x04')) {
      return
    }
    const reconfirming = session.requestKnownWindowsShiftEnterReconfirmation()
    if (submitted && !reconfirming && !session.getPaneScopedRendererOwner()) {
      session.paneForegroundAgentTracker.onAcceptedCommandBoundary()
    }
  }
  const paneEvidence = () => {
    const state = useAppStore.getState()
    const foreground = state.paneForegroundAgentByPaneKey[session.cacheKey]
    const retired = state.recentlyRetiredAgentStatusPaneKeys?.[session.cacheKey] !== undefined
    const processAgent =
      !retired && !foreground?.shellForeground && foreground?.agentEvidence === 'process-read'
        ? (foreground.agent ?? undefined)
        : undefined
    const hook =
      !retired && !foreground?.shellForeground
        ? state.agentStatusByPaneKey[session.cacheKey]
        : undefined
    const launch =
      !retired && !foreground?.shellForeground
        ? (state.agentLaunchConfigByPaneKey[session.cacheKey]?.identity.agentType ??
          (!foreground && !hook && !session.handledExitPtyId
            ? (session.paneStartup?.launchAgent ?? session.paneStartup?.initialAgentStatus?.agent)
            : undefined))
        : undefined
    const hookAgent = hook?.agentType === 'unknown' ? undefined : hook?.agentType
    return { processAgent, hook, hookAgent, launch }
  }
  session.getAuthoritativePaneAgent = (): AgentType | undefined => {
    const { processAgent, hookAgent, launch } = paneEvidence()
    return processAgent ?? resolveCompatibleAgentTypeForOwner(hookAgent, launch) ?? launch
  }
  // Display identity survives inter-turn Done; GPU policy requires live pane evidence.
  session.getPaneScopedRendererOwner = (): AgentType | undefined => {
    const { processAgent, hook, hookAgent, launch } = paneEvidence()
    return (
      processAgent ??
      (session.isFreshActivePaneAgentEntry(hook)
        ? resolveCompatibleAgentTypeForOwner(hookAgent, launch)
        : undefined)
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
    opts: { fullScreenReplay: boolean; imageTitle?: string }
  ): void => {
    session.reattachReplayPayloadSignalGeneration += 1
    // Post-parse checks for this replay must judge the same title its reset did.
    session.reattachReplayImageTitle = opts.imageTitle
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
  session.hasLiveAgentReattachStatusOrTitleSignal = (imageTitle?: string): boolean => {
    // Permanent tab launch metadata cannot prove liveness; require current status/title or restored screen shape.
    if (useAppStore.getState().agentStatusByPaneKey[session.cacheKey]) {
      return true
    }
    // A replayed image's own title outranks the store's, which arrives on a separate channel.
    const title = imageTitle ?? session.getCurrentTerminalTitle() ?? ''
    // Loose label matching can classify ssh user names; mode preservation and input injection need exact/status titles.
    return detectAgentStatusFromTitle(title) !== null || session.isCursorAgentNativeTitle(title)
  }
  session.hasLiveAgentReattachSignal = (imageTitle?: string): boolean => {
    return (
      session.hasLiveAgentReattachStatusOrTitleSignal(imageTitle) ||
      session.reattachReplayPayloadHasCursorAgentSignal
    )
  }
  session.shouldPreserveAgentReattachModes = (imageTitle?: string): boolean => {
    // Why: ordinary shells can inherit stale ?25l/?1004h from replay bytes.
    // Preserve those modes only when reattach still looks agent-owned.
    return session.hasLiveAgentReattachSignal(imageTitle)
  }
  session.shouldSendFocusedAgentReattachFocusIn = (imageTitle?: string): boolean => {
    return (
      terminalOwnsDomFocus(session.pane.terminal) &&
      session.shouldPreserveAgentReattachModes(imageTitle)
    )
  }
}
