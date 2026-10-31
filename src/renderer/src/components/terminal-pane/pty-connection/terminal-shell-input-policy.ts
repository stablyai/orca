import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { AGENT_INTERRUPT_SETTLE_MS } from '../../../../../shared/agent-interrupt-intent'
import { resolvePaneAgentOwner } from '../../../../../shared/pane-agent-owner'
import { titleAfterInferredInterrupt } from '../../../../../shared/terminal-pane-title-reset'
import type { createTerminalOwnerPolicy } from './terminal-owner-policy'
import type { PtyPaneStartup } from '../pty-connection-types'

export function createTerminalShellInputPolicy(services: {
  paneKey: string
  tabId: string
  worktreeId: string
  startup: PtyPaneStartup
  owner: ReturnType<typeof createTerminalOwnerPolicy>
  readTitle: () => string | null
  showTitle: (title: string) => void
  neutralTerminalTitle: () => string
  requestAcceptedInputDiscovery: () => void
}) {
  const observeAcceptedShellCommandInput = (data: string): void => {
    if (
      data.includes('\r') ||
      data.includes('\n') ||
      data.includes('\x03') ||
      data.includes('\x04')
    ) {
      services.requestAcceptedInputDiscovery()
    }
  }
  const getAuthoritativePaneAgent = (): AgentType | undefined => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[services.worktreeId] ?? []).find(
      (entry) => entry.id === services.tabId
    )
    return (
      resolvePaneAgentOwner({
        launchAgent: tab?.launchAgent,
        startupLaunchAgent: services.startup?.launchAgent,
        initialStatusAgent: services.startup?.initialAgentStatus?.agent,
        hookAgent: state.agentStatusByPaneKey[services.paneKey]?.agentType
      }) ?? undefined
    )
  }
  // Only a fresh active pane hook may veto the renderer; tab/startup identity can outlive a split's agent.
  const getPaneScopedRendererOwner = (): AgentType | undefined => {
    const entry = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
    return services.owner.isFreshActivePaneAgentEntry(entry) ? entry.agentType : undefined
  }
  const clearInferredInterruptWorkingTitle = (): void => {
    const state = useAppStore.getState()
    const currentTitle = services.readTitle()
    const statusTitle = state.agentStatusByPaneKey[services.paneKey]?.terminalTitle
    const neutralTitle = titleAfterInferredInterrupt(
      currentTitle ?? statusTitle,
      services.neutralTerminalTitle()
    )
    if (neutralTitle === null) {
      return
    }
    // Why: inferred interrupts update the explicit hook row, but many CLIs leave
    // their OSC title stuck on a working spinner. Replace only this fallback
    // title signal with a neutral terminal label so the existing process tracker
    // can still decide whether an agent TUI is truly alive.
    services.showTitle(neutralTitle)
  }
  let titleOnlyInterruptTimer: ReturnType<typeof setTimeout> | null = null
  const clearTitleOnlyInterruptTimer = (): void => {
    if (titleOnlyInterruptTimer !== null) {
      clearTimeout(titleOnlyInterruptTimer)
      titleOnlyInterruptTimer = null
    }
  }
  const observeTitleOnlyInterrupt = (): void => {
    const state = useAppStore.getState()
    if (state.agentStatusByPaneKey[services.paneKey]) {
      return
    }
    const runtimeTitle = services.readTitle()
    const tabTitle = (state.tabsByWorktree[services.worktreeId] ?? []).find(
      (entry) => entry.id === services.tabId
    )?.title
    const baselineTitle = runtimeTitle ?? tabTitle
    if (detectAgentStatusFromTitle(baselineTitle ?? '') !== 'working') {
      return
    }
    clearTitleOnlyInterruptTimer()
    titleOnlyInterruptTimer = setTimeout(() => {
      titleOnlyInterruptTimer = null
      if (useAppStore.getState().agentStatusByPaneKey[services.paneKey]) {
        return
      }
      const currentState = useAppStore.getState()
      const currentRuntimeTitle = services.readTitle()
      const currentTabTitle = (currentState.tabsByWorktree[services.worktreeId] ?? []).find(
        (entry) => entry.id === services.tabId
      )?.title
      const currentTitle = currentRuntimeTitle ?? currentTabTitle
      if (
        currentTitle === baselineTitle &&
        detectAgentStatusFromTitle(currentTitle ?? '') === 'working'
      ) {
        // Why: title-only agents such as Pi can miss their own idle title after
        // Ctrl+C. Clear only an unchanged, acknowledged working title.
        clearInferredInterruptWorkingTitle()
      }
    }, AGENT_INTERRUPT_SETTLE_MS)
  }
  return {
    observeAcceptedShellCommandInput,
    getAuthoritativePaneAgent,
    getPaneScopedRendererOwner,
    clearInferredInterruptWorkingTitle,
    clearTitleOnlyInterruptTimer,
    observeTitleOnlyInterrupt
  }
}
