import { resolvePaneTitleDecision } from '../../titles/terminal-title-evidence'
import { useAppStore } from '@/store'
import { shouldSeedCacheTimerOnInitialTitle } from '../../titles/cache-timer-seeding'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installPaneTitleObservation(session: ConnectPanePtySession): void {
  session.onTitleChange = (
    title: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ): void => {
    if (!meta?.staleWorkingTitleClear && resolveCommittedTitleAgentType(rawTitle)) {
      session.paneForegroundAgentTracker.onAgentStartupObserved()
    }
    // Share owner-aware display/title/completion/GPU decisions so raw title text cannot override stronger pane identity (#7428/#7447).
    const decision = resolvePaneTitleDecision({
      normalizedTitle: title,
      isGeminiTerminalTitle: session.deps.isGeminiTerminalTitle,
      rawTitle,
      displayOwnerAgentType: session.getAuthoritativePaneAgent(),
      rendererOwnerAgentType: session.getPaneScopedRendererOwner(),
      userGpuMode: useAppStore.getState().settings?.terminalGpuAcceleration ?? 'auto'
    })
    const paneTitle = decision.displayTitle
    session.manager.setPaneGpuRendering(session.pane.id, decision.rendererPolicy.gpuEnabled)
    session.deps.setRuntimePaneTitle(session.deps.tabId, session.pane.id, paneTitle)
    // Stale expiry updates display without feeding completion; silence mid-task is not observed idle.
    if (!meta?.staleWorkingTitleClear && session.syncAgentTaskCompleteTrackingEnabled()) {
      const activeHookStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      if (!session.shouldSuppressTitleCompletionForFreshHook(decision.rawTitle, activeHookStatus)) {
        // Hooks retain active-turn authority while display titles change; stale idle frames cannot precede hook done.
        session.agentCompletionCoordinator.observeTitle(decision.rawTitle)
      }
    }
    // Only active split titles drive the tab to avoid flicker; focus changes copy the newly active pane’s stored title.
    if (session.manager.getActivePane()?.id === session.pane.id) {
      session.deps.updateTabTitle(session.deps.tabId, paneTitle)
    }

    if (!session.hasConsideredInitialCacheTimerSeed) {
      session.hasConsideredInitialCacheTimerSeed = true
      const state = useAppStore.getState()
      if (
        shouldSeedCacheTimerOnInitialTitle({
          rawTitle,
          allowInitialIdleSeed: session.allowInitialIdleCacheSeed,
          existingTimerStartedAt: state.cacheTimerByKey[session.cacheKey],
          promptCacheTimerEnabled: state.settings?.promptCacheTimerEnabled ?? null
        })
      ) {
        session.deps.setCacheTimerStartedAt(session.cacheKey, Date.now())
      }
    }
  }
}
