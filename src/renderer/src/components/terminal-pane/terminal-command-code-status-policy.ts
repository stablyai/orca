import { captureTerminalFactSubject } from './terminal-fact-subject'
import { useAppStore } from '@/store'
import type { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'
import type { TerminalTransientCurrent } from '../../../../shared/terminal-transient-observation'
import {
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle,
  setCommandCodeDoneSettleExecutor
} from './command-code-done-settle'

export function readInFlightCommandCodeTurn(paneKey: string): { prompt: string } | null {
  const entry = useAppStore.getState().agentStatusByPaneKey?.[paneKey]
  if (entry?.agentType !== 'command-code' || entry.state !== 'working') {
    return null
  }
  return { prompt: entry.prompt }
}

export function createTerminalCommandCodeStatusPolicy(options: {
  paneKey: string
  resolveRouting: () => ReturnType<typeof resolveLiveAgentStatusConnectionRouting>
  canApply: () => boolean
  readTitle: () => string | undefined
}) {
  const { paneKey } = options
  const clearCommandCodeOutputDoneTimer = (): void => cancelCommandCodeDoneSettle(paneKey)
  // Complete the row only while it is still this turn's command-code/working entry.
  const settleCommandCodeDone = (normalizedPrompt: string): void => {
    const routing = options.resolveRouting()
    if (!routing) {
      return
    }
    const currentState = useAppStore.getState()
    const currentEntry = currentState.agentStatusByPaneKey[paneKey]
    if (currentEntry?.agentType !== 'command-code' || currentEntry.state !== 'working') {
      return
    }
    const currentPrompt = currentEntry.prompt.trim()
    if (currentPrompt && currentPrompt !== normalizedPrompt) {
      return
    }
    const currentTitle = options.readTitle()
    currentState.setAgentStatus(
      paneKey,
      {
        state: 'done',
        prompt: currentPrompt || normalizedPrompt,
        agentType: 'command-code',
        observation: rendererAgentStatusObservations.observe(paneKey, {
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

  // Why the shared window: reveal disposes this watcher mid-settle and the remounted pane
  // cannot re-observe the already-passed idle composer, so the deadline outlives whichever
  // side owns the row — cancelling would strand 'working', flushing would complete the turn
  // unrecoverably early (the same-prompt-done guard then drops a genuine working repaint).
  const releaseCommandCodeDoneSettleExecutor = setCommandCodeDoneSettleExecutor(
    paneKey,
    settleCommandCodeDone
  )

  return {
    restoreCurrent: (current: TerminalTransientCurrent['commandCode']): void => {
      if (!current.armed || current.phase === 'unseen' || !options.canApply()) {
        return
      }
      const routing = options.resolveRouting()
      if (!routing) {
        return
      }
      useAppStore.getState().setAgentStatus(
        paneKey,
        {
          state: current.phase,
          prompt: current.prompt,
          agentType: 'command-code',
          observation: rendererAgentStatusObservations.observe(paneKey, {
            origin: 'process',
            observedAt: current.observedAt,
            kind: 'snapshot'
          })
        },
        options.readTitle(),
        {
          updatedAt: current.observedAt,
          evidenceObservedAt: current.observedAt,
          stateStartedAt: current.observedAt
        },
        routing
      )
    },
    onCommandCodeWorking: (prompt: string): void => {
      if (!options.canApply()) {
        return
      }
      clearCommandCodeOutputDoneTimer()
      const routing = options.resolveRouting()
      if (!routing) {
        return
      }
      const currentState = useAppStore.getState()
      const currentEntry = currentState.agentStatusByPaneKey[paneKey]
      const currentTitle = options.readTitle()
      const normalizedPrompt = prompt.trim()
      if (
        currentEntry?.agentType === 'command-code' &&
        currentEntry.state === 'done' &&
        (!normalizedPrompt || normalizedPrompt === currentEntry.prompt.trim())
      ) {
        return
      }
      currentState.setAgentStatus(
        paneKey,
        {
          state: 'working',
          prompt:
            normalizedPrompt || (currentEntry?.state === 'working' ? currentEntry.prompt : ''),
          agentType: 'command-code',
          observation: rendererAgentStatusObservations.observe(paneKey, {
            origin: 'process',
            observedAt: Date.now(),
            kind: 'transition'
          })
        },
        currentTitle,
        undefined,
        routing
      )
    },

    // The composer repaints during tools; a fresh active repaint cancels completion.
    onCommandCodeDone: (prompt: string): void => {
      if (!options.canApply()) {
        return
      }
      const normalizedPrompt = prompt.trim()
      if (!normalizedPrompt) {
        cancelCommandCodeDoneSettle(paneKey)
        return
      }
      const subject = captureTerminalFactSubject(paneKey)
      openCommandCodeDoneSettle(
        paneKey,
        normalizedPrompt,
        () => options.canApply() && subject.isCurrent()
      )
    },
    clearDoneTimer: clearCommandCodeOutputDoneTimer,
    dispose: () => {
      cancelCommandCodeDoneSettle(paneKey)
      releaseCommandCodeDoneSettleExecutor()
    }
  }
}
