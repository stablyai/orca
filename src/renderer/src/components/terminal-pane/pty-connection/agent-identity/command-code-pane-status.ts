import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { useAppStore } from '@/store'
import {
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle,
  setCommandCodeDoneSettleExecutor
} from '../../agent-completion/command-code/command-code-done-settle'
import { canCommandCodeOutputOwnPane } from '../../agent-completion/command-code/command-code-output-ownership'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'

export function bindCommandCodeOutputStatus(session: ConnectPanePtySession): void {
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
}
