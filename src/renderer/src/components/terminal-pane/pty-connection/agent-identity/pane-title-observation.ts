import { resolvePaneTitleDecision } from '../../titles/terminal-title-evidence'
import { useAppStore } from '@/store'
import { shouldSeedCacheTimerOnInitialTitle } from '../../titles/cache-timer-seeding'
import { resolveExplicitTerminalTitleAgentType } from '../../../../../../shared/agent-status/title/terminal-title-agent-type'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installPaneTitleObservation(session: ConnectPanePtySession): void {
  session.onTitleChange = (
    title: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ): void => {
    if (!meta?.staleWorkingTitleClear && resolveExplicitTerminalTitleAgentType(rawTitle)) {
      session.paneForegroundAgentTracker.onAgentStartupObserved()
    }
    // Share owner-aware display/title/completion decisions so raw title text cannot override stronger pane identity (#7428/#7447).
    const decision = resolvePaneTitleDecision({
      normalizedTitle: title,
      rawTitle,
      displayOwnerAgentType: session.getAuthoritativePaneAgent()
    })
    const paneTitle = decision.displayTitle
    // Only active split titles drive the tab to avoid flicker; focus changes copy the newly active pane’s stored title.
    session.deps.setRuntimePaneTitle(session.deps.tabId, session.pane.id, paneTitle, {
      alsoTabTitle: session.manager.getActivePane()?.id === session.pane.id
    })
    // Stale expiry updates display without feeding completion; silence mid-task is not observed idle.
    if (!meta?.staleWorkingTitleClear && session.syncAgentTaskCompleteTrackingEnabled()) {
      const activeHookStatus = useAppStore.getState().agentStatusByPaneKey.get(session.cacheKey)
      if (!session.shouldSuppressTitleCompletionForFreshHook(decision.rawTitle, activeHookStatus)) {
        // Hooks retain active-turn authority while display titles change; stale idle frames cannot precede hook done.
        session.agentCompletionCoordinator.observeTitle(decision.rawTitle)
      }
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
