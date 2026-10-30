import { resolvePaneTitleDecision } from '../terminal-title-evidence'
import { useAppStore } from '@/store'
import { shouldSeedCacheTimerOnInitialTitle } from '../cache-timer-seeding'
import {
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle,
  setCommandCodeDoneSettleExecutor
} from '../command-code-done-settle'
import { canCommandCodeOutputOwnPane } from '../command-code-output-ownership'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { installPanePtyVisibilityBind } from './pane-pty-visibility-bind'

export function installTitleSpawnBell(session: ConnectPanePtySession): void {
  let lastTitle: {
    title: string
    rawTitle: string
    displayTitle: string
    ptyId: string | null
  } | null = null
  const presentTitle = (title: string, rawTitle: string) => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle: title,
      rawTitle,
      displayOwnerAgentType: session.getAuthoritativePaneAgent(),
      rendererOwnerAgentType: session.getPaneScopedRendererOwner(),
      userGpuMode: useAppStore.getState().settings?.terminalGpuAcceleration ?? 'auto'
    })
    const paneTitle = decision.displayTitle
    lastTitle = { title, rawTitle, displayTitle: paneTitle, ptyId: session.transport.getPtyId() }
    session.manager.setPaneGpuRendering(session.pane.id, decision.rendererPolicy.gpuEnabled)
    session.deps.setRuntimePaneTitle(session.deps.tabId, session.pane.id, paneTitle)
    if (session.manager.getActivePane()?.id === session.pane.id) {
      session.deps.updateTabTitle(session.deps.tabId, paneTitle)
    }
    return decision
  }
  let displayOwner = session.getAuthoritativePaneAgent()
  let rendererOwner = session.getPaneScopedRendererOwner()
  const initial = useAppStore.getState()
  let previousForeground = initial.paneForegroundAgentByPaneKey[session.cacheKey]
  let previousStatus = initial.agentStatusByPaneKey[session.cacheKey]
  let previousLaunch = initial.agentLaunchConfigByPaneKey[session.cacheKey]
  let previousRetirement = initial.recentlyRetiredAgentStatusPaneKeys?.[session.cacheKey]
  session.waitTeardowns.push(
    useAppStore.subscribe((state) => {
      const key = session.cacheKey
      const foreground = state.paneForegroundAgentByPaneKey[key]
      const entry = state.agentStatusByPaneKey[key]
      const launch = state.agentLaunchConfigByPaneKey[key]
      const retirement = state.recentlyRetiredAgentStatusPaneKeys?.[key]
      const changed =
        foreground !== previousForeground ||
        entry !== previousStatus ||
        launch !== previousLaunch ||
        retirement !== previousRetirement
      previousForeground = foreground
      previousStatus = entry
      previousLaunch = launch
      previousRetirement = retirement
      if (!changed || session.disposed || !session.transport?.getPtyId()) {
        return
      }
      const nextDisplayOwner = session.getAuthoritativePaneAgent()
      const nextRendererOwner = session.getPaneScopedRendererOwner()
      const ownerChanged = displayOwner !== nextDisplayOwner || rendererOwner !== nextRendererOwner
      displayOwner = nextDisplayOwner
      rendererOwner = nextRendererOwner
      if (entry && foreground) {
        state.correctAgentStatusIdentity(key, entry, foreground)
      }
      if (ownerChanged && lastTitle && lastTitle.ptyId === session.transport.getPtyId()) {
        const liveTitle =
          useAppStore.getState().runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
        if (liveTitle === lastTitle.displayTitle) {
          presentTitle(lastTitle.title, lastTitle.rawTitle)
        } else {
          lastTitle = null
        }
      }
    })
  )
  session.onTitleChange = (
    title: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ): void => {
    if (!meta?.staleWorkingTitleClear && resolveCommittedTitleAgentType(rawTitle)) {
      session.paneForegroundAgentTracker.onAgentStartupObserved()
    }
    const decision = presentTitle(title, rawTitle)
    // Stale expiry updates display without feeding completion; silence mid-task is not observed idle.
    if (!meta?.staleWorkingTitleClear && session.syncAgentTaskCompleteTrackingEnabled()) {
      const activeHookStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
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

  session.applyInitialAgentStatus = (terminalTitle?: string): void => {
    const startup = session.paneStartup
    const initialStatus = startup?.initialAgentStatus
    const routing = session.resolveCurrentAgentStatusRouting()
    if (!initialStatus || !routing || startup.resumeSource?.cancelled) {
      return
    }
    const statusPayload = {
      state: 'working' as const,
      prompt: initialStatus.prompt,
      agentType: resolveCompatibleAgentTypeForOwner(
        initialStatus.agent,
        session.getAuthoritativePaneAgent()
      ),
      observation: rendererAgentStatusObservations.observe(session.cacheKey, {
        origin: 'launch',
        observedAt: Date.now(),
        kind: 'transition'
      })
    }
    if (session.paneStartup.launchConfig) {
      useAppStore
        .getState()
        .setAgentStatus(session.cacheKey, statusPayload, terminalTitle, undefined, routing, {
          launchConfig: session.paneStartup.launchConfig,
          ...(session.launchToken ? { launchToken: session.launchToken } : {})
        })
    } else {
      useAppStore
        .getState()
        .setAgentStatus(session.cacheKey, statusPayload, terminalTitle, undefined, routing)
    }
    if (startup.resumeSource) {
      session.savedStartupStatus = {
        source: startup.resumeSource,
        entry: useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      }
    }
  }

  session.canApplyCommandCodeOutputStatus = (): boolean => {
    const state = useAppStore.getState()
    const foreground = state.paneForegroundAgentByPaneKey[session.cacheKey]
    return canCommandCodeOutputOwnPane({
      foregroundAgent: foreground?.agent,
      shellForeground: foreground?.shellForeground,
      paneOwnerAgent: session.getAuthoritativePaneAgent(),
      retainedPaneOwnerAgent: state.retainedAgentsByPaneKey[session.cacheKey]?.agentType
    })
  }

  session.seedCommandCodeOutputWorkingStatus = (prompt: string): void => {
    if (!session.canApplyCommandCodeOutputStatus()) {
      return
    }
    session.clearCommandCodeOutputDoneTimer()
    const routing = session.resolveCurrentAgentStatusRouting()
    if (!routing) {
      return
    }
    const currentState = useAppStore.getState()
    const currentEntry = currentState.agentStatusByPaneKey[session.cacheKey]
    const currentTitle =
      currentState.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
    const normalizedPrompt = prompt.trim()
    if (
      currentEntry?.agentType === 'command-code' &&
      currentEntry.state === 'done' &&
      (!normalizedPrompt || normalizedPrompt === currentEntry.prompt.trim())
    ) {
      return
    }
    currentState.setAgentStatus(
      session.cacheKey,
      {
        state: 'working',
        prompt: normalizedPrompt || (currentEntry?.state === 'working' ? currentEntry.prompt : ''),
        agentType: 'command-code',
        observation: rendererAgentStatusObservations.observe(session.cacheKey, {
          origin: 'process',
          observedAt: Date.now(),
          kind: 'transition'
        })
      },
      currentTitle,
      undefined,
      routing
    )
  }

  // Turn settle deadlines outlive park/remount; only row-routing writes remain pane-local so the next owner inherits completion.
  session.releaseCommandCodeDoneSettleExecutor = setCommandCodeDoneSettleExecutor(
    session.cacheKey,
    (normalizedPrompt) => {
      const routing = session.resolveCurrentAgentStatusRouting()
      if (!routing) {
        return
      }
      const currentState = useAppStore.getState()
      const currentEntry = currentState.agentStatusByPaneKey[session.cacheKey]
      if (currentEntry?.agentType !== 'command-code' || currentEntry.state !== 'working') {
        return
      }
      const currentPrompt = currentEntry.prompt.trim()
      if (currentPrompt && currentPrompt !== normalizedPrompt) {
        return
      }
      const currentTitle =
        currentState.runtimePaneTitlesByTabId?.[session.deps.tabId]?.[session.pane.id]
      currentState.setAgentStatus(
        session.cacheKey,
        {
          state: 'done',
          prompt: currentPrompt || normalizedPrompt,
          agentType: 'command-code',
          observation: rendererAgentStatusObservations.observe(session.cacheKey, {
            origin: 'process',
            observedAt: Date.now(),
            kind: 'transition'
          })
        },
        currentTitle,
        undefined,
        routing
      )
    }
  )
  session.clearCommandCodeOutputDoneTimer = (): void =>
    cancelCommandCodeDoneSettle(session.cacheKey)
  session.scheduleCommandCodeOutputDoneStatus = (prompt: string): void => {
    if (!session.canApplyCommandCodeOutputStatus()) {
      return
    }
    const normalizedPrompt = prompt.trim()
    if (!normalizedPrompt) {
      cancelCommandCodeDoneSettle(session.cacheKey)
      return
    }
    // Command Code renders the composer during tools; complete only without an active repaint during settling.
    openCommandCodeDoneSettle(session.cacheKey, normalizedPrompt)
  }

  installPanePtyVisibilityBind(session)
}
