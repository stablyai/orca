import { forgetRefusedPaneResume } from '@/lib/forget-refused-pane-resume'
import { useAppStore } from '@/store'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { PtyPaneStartup } from '../pty-connection-types'
import type { PtyConnectResult } from '../pty-transport-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { clearStaleAgentTabTitleOnConfirmedShell } from './confirmed-shell-agent-title'

export function installSavedResumeStartupCancellation(session: ConnectPanePtySession): void {
  session.cancelSavedResumeStartup = (
    startup: ColdRestoreAgentResumeStartup | PtyPaneStartup | null | undefined,
    result: PtyConnectResult
  ): void => {
    const source = startup?.resumeSource
    if (!startup || !source) {
      return
    }
    source.cancelled = true
    const state = useAppStore.getState()
    if (session.pendingStartupCommand?.resumeSource === source) {
      session.pendingStartupCommand = null
      if (session.startupInjectTimer !== null) {
        clearTimeout(session.startupInjectTimer)
      }
      session.startupInjectTimer = null
    }
    if (session.deferredSpawn?.startupOverride?.resumeSource === source) {
      session.deferredSpawn = null
    }
    const ownsPaneStartup = session.paneStartup?.resumeSource === source
    if (ownsPaneStartup) {
      session.paneStartup = null
      session.startupDraftPrompt = null
    }
    state.consumeTabStartupCommand(session.deps.tabId, startup)
    const registered = session.savedStartupLaunchRegistration
    const ownsRegistration =
      registered?.source === source &&
      registered.entry !== undefined &&
      registered.entry === state.agentLaunchConfigByPaneKey[session.cacheKey]
    session.clearRegisteredStartupLaunchConfig(startup)
    const claim = state.automaticAgentResumeClaimsByTabId[session.deps.tabId]
    if (ownsPaneStartup && claim && claim === session.savedStartupAutomaticClaim) {
      useAppStore.setState((current) => {
        if (current.automaticAgentResumeClaimsByTabId[session.deps.tabId] !== claim) {
          return current
        }
        const next = { ...current.automaticAgentResumeClaimsByTabId }
        delete next[session.deps.tabId]
        return { automaticAgentResumeClaimsByTabId: next }
      })
    }
    if (ownsPaneStartup || ownsRegistration) {
      const pending = state.pendingStartupByTabId[session.deps.tabId]
      const installed = useAppStore.getState().agentLaunchConfigByPaneKey[session.cacheKey]
      const replaced = pending && pending.resumeSource !== source
      if (!replaced && !installed) {
        const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
          (entry) => entry.id === session.deps.tabId
        )
        if (
          tab?.launchAgent === ('agent' in startup ? startup.agent : startup.launchAgent) &&
          (tab?.generation ?? 0) === session.tabGeneration
        ) {
          state.clearTabLaunchAgent(session.deps.tabId)
          clearStaleAgentTabTitleOnConfirmedShell(session)
        }
      }
    }
    if (ownsPaneStartup) {
      const seeded = session.savedStartupStatus
      if (seeded?.source === source) {
        useAppStore.getState().updateAgentStatusState((current, changedPaneKeys) => {
          if (current.agentStatusByPaneKey[session.cacheKey] !== seeded.entry) {
            return current
          }
          const next = { ...current.agentStatusByPaneKey }
          changedPaneKeys.add(session.cacheKey)
          delete next[session.cacheKey]
          return { agentStatusByPaneKey: next }
        })
      }
      session.cleanupStartupDraftPasteTimers?.()
    }
    if (
      result.agentResumeRefused !== 'unverifiable' &&
      source.expectedStatus &&
      startup.resumeProviderSession
    ) {
      forgetRefusedPaneResume(state, source.expectedStatus.paneKey, {
        agent: 'agent' in startup ? startup.agent : (startup.launchAgent ?? ''),
        providerSession: startup.resumeProviderSession,
        expectedStatus: source.expectedStatus
      })
    }
    const captured = source.record
    if (!captured) {
      return
    }
    const current = state.sleepingAgentSessionsByPaneKey[captured.paneKey]
    if (result.agentResumeRefused === 'unverifiable') {
      if (!current) {
        state.rememberSleepingAgentSession(captured)
      }
    } else if (current === captured) {
      state.clearSleepingAgentSession(captured.paneKey)
    }
  }
}
