import { resolvePaneTitleDecision } from '../../titles/terminal-title-evidence'
import { useAppStore } from '@/store'
import { createRestoredPromptCacheTimer } from '../../titles/restored-prompt-cache-timer'
import { createPromptCacheCommandFinishedHold } from '../../agent-status/prompt-cache-command-finished-hold'
import { foregroundIsLiveClaude } from '@/lib/agent-status/evidence/prompt-cache-request-evidence'
import { resolveExplicitTerminalTitleAgentType } from '../../../../../../shared/agent-status/title/terminal-title-agent-type'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installPaneTitleObservation(session: ConnectPanePtySession): void {
  session.promptCacheCommandFinishedHold = createPromptCacheCommandFinishedHold({
    paneKey: session.cacheKey,
    setCacheTimerStartedAt: session.deps.setCacheTimerStartedAt
  })
  // The foreground tracker's publish retries it, so a restore waits on this pane's evidence only.
  session.restoredCacheTimer = createRestoredPromptCacheTimer({
    paneKey: session.cacheKey,
    allowInitialIdleSeed: () => session.allowInitialIdleCacheSeed,
    liveClaude: () =>
      foregroundIsLiveClaude(useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey]),
    // A reattached pane gets no command boundary to read on, so ask for the tracker's bounded startup read.
    requestProcessRead: () => session.paneForegroundAgentTracker.onAgentStartupObserved(),
    setCacheTimerStartedAt: session.deps.setCacheTimerStartedAt
  })
  // A command boundary means a later read finds a newer session than the one either wait restores.
  session.endPromptCacheWaitsOnCommandStarted = (): void => {
    session.promptCacheCommandFinishedHold.discard()
    session.restoredCacheTimer.endWait()
  }
  session.endPromptCacheWaitsOnCommandFinished = (): void => {
    session.promptCacheCommandFinishedHold.onCommandFinished()
    session.restoredCacheTimer.endWait()
  }
  session.onTitleChange = (
    title: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ): void => {
    if (!meta?.staleWorkingTitleClear && resolveExplicitTerminalTitleAgentType(rawTitle)) {
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

    session.promptCacheCommandFinishedHold.observeTitle(rawTitle)
    session.restoredCacheTimer.observeTitle(rawTitle)
    if (!session.hasConsideredInitialCacheTimerSeed) {
      session.hasConsideredInitialCacheTimerSeed = true
      session.restoredCacheTimer.restore(rawTitle)
    }
  }
}
