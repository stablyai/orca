// Parked panes update command status without pane-specific input handling.
import { resolvePaneAgentOwner } from '../../../../shared/pane-agent-owner'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'
import { useAppStore } from '@/store'
import {
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle,
  setCommandCodeDoneSettleExecutor
} from './command-code-done-settle'
import { canCommandCodeOutputOwnPane } from './command-code-output-ownership'
import { isRemoteExecutionHostPtyId } from './remote-execution-host-pty'

export type ParkedTerminalCommandStatusPolicy = {
  onCommandFinished: (bestEffortExitCode: number | null) => void
  onCommandCodeWorking: (prompt: string) => void
  onCommandCodeDone: (prompt: string) => void
  dispose: () => void
}

// Why only 'working': an in-flight turn is the one state a recreated detector can still
// resolve, and it proves the Command Code TUI is live — a stale 'done' row would arm the
// scrape against whatever process replaced it. Shared by parked watchers and the reveal
// remount, which both recreate the detector long past the banner.
export function readInFlightCommandCodeTurn(paneKey: string): { prompt: string } | null {
  const entry = useAppStore.getState().agentStatusByPaneKey?.[paneKey]
  if (entry?.agentType !== 'command-code' || entry.state !== 'working') {
    return null
  }
  return { prompt: entry.prompt }
}

export function createParkedTerminalCommandStatusPolicy(options: {
  ptyId: string
  worktreeId: string
  tabId: string
  /** PaneManager pane id whose runtime-title slot the watcher writes; read for status title pairing. */
  paneId: number
  paneKey: string
}): ParkedTerminalCommandStatusPolicy {
  const { ptyId, worktreeId, tabId, paneId, paneKey } = options
  let disposed = false
  const clearCommandCodeOutputDoneTimer = (): void => cancelCommandCodeDoneSettle(paneKey)

  const resolveRouting = (): ReturnType<typeof resolveLiveAgentStatusConnectionRouting> => {
    if (disposed) {
      return undefined
    }
    const state = useAppStore.getState()
    return resolveLiveAgentStatusConnectionRouting({
      state,
      paneKey,
      ptyId,
      expectedConnectionId: getConnectionIdFromState(state, worktreeId)
    })
  }

  const canApplyCommandCodeOutputStatus = (): boolean => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[worktreeId] ?? []).find((entry) => entry.id === tabId)
    const foreground = state.paneForegroundAgentByPaneKey[paneKey]
    const paneOwnerAgent = resolvePaneAgentOwner({
      launchAgent: tab?.launchAgent,
      startupLaunchAgent: state.agentLaunchConfigByPaneKey[paneKey]?.identity.agentType,
      hookAgent: state.agentStatusByPaneKey[paneKey]?.agentType
    })
    return canCommandCodeOutputOwnPane({
      foregroundAgent: foreground?.agent,
      shellForeground: foreground?.shellForeground,
      paneOwnerAgent,
      retainedPaneOwnerAgent: state.retainedAgentsByPaneKey[paneKey]?.agentType
    })
  }

  // Complete the row only while it is still this turn's command-code/working entry.
  const settleCommandCodeDone = (normalizedPrompt: string): void => {
    const routing = resolveRouting()
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
    const currentTitle = currentState.runtimePaneTitlesByTabId?.[tabId]?.[paneId]
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

  // Why: a full-screen agent's nested shells leak 133;D, so make one confirming read (no retry
  // ladder, unlike the mounted tracker) and retire the process read only on a shell or no answer.
  const retireForegroundAgentUnlessConfirmed = async (): Promise<void> => {
    const entry = useAppStore.getState().paneForegroundAgentByPaneKey[paneKey]
    if (!entry?.agent) {
      return
    }
    // Why: a parked pane holds no remote incarnation to fence host evidence with, so it has no answer.
    const remote = isRemoteExecutionHostPtyId(ptyId) || parseAppSshPtyId(ptyId) !== null
    let processName: string | null = null
    if (!remote) {
      try {
        processName = await window.api.pty.confirmForegroundProcess(ptyId)
      } catch {
        processName = null
      }
    }
    const state = useAppStore.getState()
    if (disposed || state.paneForegroundAgentByPaneKey[paneKey] !== entry) {
      return
    }
    if (processName === null || isShellProcess(processName)) {
      state.setPaneForegroundAgent(paneKey, { agent: null, shellForeground: false })
    }
  }

  return {
    onCommandFinished: (bestEffortExitCode: number | null): void => {
      if (disposed) {
        return
      }
      // Why: the finished command may have moved HEAD or the index (an agent running
      // `git checkout` in a parked worktree); nudge git UI now instead of waiting for a poll.
      dispatchTerminalCommandFinishedEvent(worktreeId, bestEffortExitCode)
      // Command-finished markers do not prove that an agent process exited.
      void retireForegroundAgentUnlessConfirmed()
    },

    // Port of pty-connection's seedCommandCodeOutputWorkingStatus (store-level only).
    onCommandCodeWorking: (prompt: string): void => {
      if (!canApplyCommandCodeOutputStatus()) {
        return
      }
      clearCommandCodeOutputDoneTimer()
      const routing = resolveRouting()
      if (!routing) {
        return
      }
      const currentState = useAppStore.getState()
      const currentEntry = currentState.agentStatusByPaneKey[paneKey]
      const currentTitle = currentState.runtimePaneTitlesByTabId?.[tabId]?.[paneId]
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

    // Port of pty-connection's scheduleCommandCodeOutputDoneStatus: Command Code keeps rendering
    // the composer while tools run, so only complete the row if no active repaint arrives.
    onCommandCodeDone: (prompt: string): void => {
      if (!canApplyCommandCodeOutputStatus()) {
        return
      }
      const normalizedPrompt = prompt.trim()
      if (!normalizedPrompt) {
        cancelCommandCodeDoneSettle(paneKey)
        return
      }
      openCommandCodeDoneSettle(paneKey, normalizedPrompt)
    },

    dispose: (): void => {
      // Why release, not flush: the settle window belongs to the turn and outlives this
      // watcher, so the remounted pane inherits the remaining deadline and a working
      // repaint arriving before it still cancels the completion.
      releaseCommandCodeDoneSettleExecutor()
      disposed = true
    }
  }
}
