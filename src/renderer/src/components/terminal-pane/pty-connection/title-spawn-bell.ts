import { resolvePaneTitleDecision } from '../terminal-title-evidence'
import { useAppStore } from '@/store'
import { shouldSeedCacheTimerOnInitialTitle } from '../cache-timer-seeding'
import { shouldSuppressCodexAutoApprovalSyntheticTitle } from '../codex-auto-approval-notification-suppression'
import {
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle,
  setCommandCodeDoneSettleExecutor
} from '../command-code-done-settle'
import { canAgentOutputOwnPane } from '../command-code-output-ownership'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { installPanePtyVisibilityBind } from './pane-pty-visibility-bind'

export function installTitleSpawnBell(session: ConnectPanePtySession): void {
  session.onTitleChange = (
    title: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ): void => {
    // Why: one owner-aware decision drives the display label, the runtime/tab
    // title, task-completion tracking, and the renderer gate, so raw title text
    // can no longer disable GPU behind stronger owner evidence (#7428/#7447).
    const decision = resolvePaneTitleDecision({
      normalizedTitle: title,
      rawTitle,
      displayOwnerAgentType: session.getAuthoritativePaneAgent(),
      rendererOwnerAgentType: session.getPaneScopedRendererOwner(),
      userGpuMode: useAppStore.getState().settings?.terminalGpuAcceleration ?? 'auto'
    })
    const paneTitle = decision.displayTitle
    if (
      shouldSuppressCodexAutoApprovalSyntheticTitle(paneTitle, {
        paneKey: session.cacheKey,
        tabId: session.deps.tabId,
        ...(session.launchToken ? { launchToken: session.launchToken } : {})
      })
    ) {
      return
    }
    session.manager.setPaneGpuRendering(session.pane.id, decision.rendererPolicy.gpuEnabled)
    session.deps.setRuntimePaneTitle(session.deps.tabId, session.pane.id, paneTitle)
    // Why: a stale-derived cleared title comes from main's unthrottled 3s
    // timer, not agent output. It must update the visible title but never
    // feed completion tracking — observeTitle would classify the cleared
    // title as idle and mint a task-complete for a merely-paused agent.
    if (!meta?.staleWorkingTitleClear && session.syncAgentTaskCompleteTrackingEnabled()) {
      const activeHookStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      if (!session.shouldSuppressTitleCompletionForFreshHook(decision.rawTitle, activeHookStatus)) {
        // Why: display titles still update while hooks are active, but a stale
        // idle frame must not complete the coordinator turn before hook `done`.
        session.agentCompletionCoordinator.observeTitle(decision.rawTitle)
      }
    }
    // Why: only the focused pane should drive the tab title — otherwise two
    // agents in split panes cause rapid title flickering as each emits OSC
    // sequences. Only the active split's title propagates to the tab. When
    // focus changes, onActivePaneChange syncs the newly active pane's stored
    // title to the tab.
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

  session.applyInitialAgentStatus = (terminalTitle?: string): void => {
    const initialStatus = session.paneStartup?.initialAgentStatus
    const routing = session.resolveCurrentAgentStatusRouting()
    if (!initialStatus || !routing) {
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
      return
    }
    useAppStore
      .getState()
      .setAgentStatus(session.cacheKey, statusPayload, terminalTitle, undefined, routing)
  }

  session.canApplyAgentOutputStatus = (agent: TuiAgent): boolean => {
    const state = useAppStore.getState()
    const foreground = state.paneForegroundAgentByPaneKey[session.cacheKey]
    return canAgentOutputOwnPane({
      agent,
      foregroundAgent: foreground?.agent,
      shellForeground: foreground?.shellForeground,
      paneOwnerAgent: session.getAuthoritativePaneAgent(),
      retainedPaneOwnerAgent: state.retainedAgentsByPaneKey[session.cacheKey]?.agentType
    })
  }

  session.seedAgentOutputRow = (
    agent: TuiAgent,
    state: 'working' | 'waiting',
    prompt: string
  ): void => {
    if (!session.canApplyAgentOutputStatus(agent)) {
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
      currentEntry?.agentType === agent &&
      currentEntry.state === 'done' &&
      (!normalizedPrompt || normalizedPrompt === currentEntry.prompt.trim())
    ) {
      return
    }
    currentState.setAgentStatus(
      session.cacheKey,
      {
        state,
        prompt:
          normalizedPrompt ||
          // Why: only this agent's own unfinished turn may lend its prompt; a
          // pane just taken over from another agent must not inherit that prompt.
          (currentEntry?.agentType === agent &&
          (currentEntry.state === 'working' || currentEntry.state === 'waiting')
            ? currentEntry.prompt
            : ''),
        agentType: agent,
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
  session.seedCommandCodeOutputWorkingStatus = (prompt: string): void =>
    session.seedAgentOutputRow('command-code', 'working', prompt)

  // Why the settle window lives outside this binding: park unmounts the pane
  // mid-settle, so a pane-owned timer would be cancelled with nothing left to
  // complete the turn — the row would stick at 'working'. Only the row write
  // (routing + title slot) is pane-local; the deadline transfers to whichever
  // owner (parked watcher or remounted pane) holds the pane next.
  session.releaseCommandCodeDoneSettleExecutor = setCommandCodeDoneSettleExecutor(
    session.cacheKey,
    (normalizedPrompt, agent) => {
      const routing = session.resolveCurrentAgentStatusRouting()
      if (!routing) {
        return
      }
      const currentState = useAppStore.getState()
      const currentEntry = currentState.agentStatusByPaneKey[session.cacheKey]
      // Why: a waiting (approval) row is the same unfinished turn; an approval that
      // ends the turn returns to the composer with no spinner in between.
      if (
        currentEntry?.agentType !== agent ||
        (currentEntry.state !== 'working' && currentEntry.state !== 'waiting')
      ) {
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
          agentType: agent,
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
  session.scheduleAgentOutputDoneStatus = (agent: TuiAgent, prompt: string): void => {
    if (!session.canApplyAgentOutputStatus(agent)) {
      return
    }
    const normalizedPrompt = prompt.trim()
    if (!normalizedPrompt) {
      cancelCommandCodeDoneSettle(session.cacheKey)
      return
    }
    // Why: these TUIs keep rendering the composer while tools run. Only
    // complete the row if no active status repaint arrives during this window.
    openCommandCodeDoneSettle(session.cacheKey, normalizedPrompt, agent)
  }
  session.scheduleCommandCodeOutputDoneStatus = (prompt: string): void =>
    session.scheduleAgentOutputDoneStatus('command-code', prompt)

  installPanePtyVisibilityBind(session)
}
