/** Keep store-level command status while parked; foreground confirmation and input-intent inference remain with mounted panes. */
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { resolvePaneAgentOwner } from '../../../../shared/pane-agent-owner'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'
import { isRetainedProgramResult } from '@/lib/program-status/row'
import { useAppStore } from '@/store'
import {
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle,
  setCommandCodeDoneSettleExecutor
} from './command-code-done-settle'
import { canCommandCodeOutputOwnPane } from './command-code-output-ownership'
import { isRemoteExecutionHostPtyId } from '../../../../shared/remote-execution-host-pty-id'

export type ParkedTerminalCommandStatusPolicy = {
  onCommandFinished: (bestEffortExitCode: number | null) => void
  onCommandCodeWorking: (prompt: string) => void
  onCommandCodeDone: (prompt: string) => void
  dispose: () => void
}

// Only working rows prove a live Command Code turn; stale done rows could arm a recreated detector against its replacement.
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

  // Mirror mounted same-turn status drops without interrupt inference: parked panes receive no key events.
  const dropCommandFinishedStatusIfSameTurn = (entry: AgentStatusEntry | undefined): void => {
    const state = useAppStore.getState()
    if (!entry) {
      // An agent can exit before its first hook; clear launch identity on command exit like mounted panes.
      state.clearAgentLaunchConfig(paneKey)
      return
    }
    const current = state.agentStatusByPaneKey[paneKey]
    if (!current) {
      state.clearAgentLaunchConfig(paneKey)
      return
    }
    const unchanged =
      current.state === entry.state &&
      current.prompt === entry.prompt &&
      current.updatedAt === entry.updatedAt &&
      current.stateStartedAt === entry.stateStartedAt &&
      current.agentType === entry.agentType
    if (!unchanged) {
      return
    }
    if (!isRetainedProgramResult(current)) {
      state.dropAgentStatus(paneKey)
    }
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

  // Reveal inherits the turn’s settle deadline: cancelling strands working state; flushing makes genuine working repaints irrecoverably late.
  const releaseCommandCodeDoneSettleExecutor = setCommandCodeDoneSettleExecutor(
    paneKey,
    settleCommandCodeDone
  )

  // Confirm nested-shell 133;D once before retiring identity; mounted panes own the retry ladder.
  const retireForegroundAgentUnlessConfirmed = async (): Promise<void> => {
    const entry = useAppStore.getState().paneForegroundAgentByPaneKey[paneKey]
    if (!entry?.agent) {
      return
    }
    // Why: a parked pane holds no remote incarnation to fence host evidence with, so it has no answer.
    const remote = isRemoteExecutionHostPtyId(ptyId)
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
      // Commands can change HEAD/index; nudge git UI immediately rather than wait for polling.
      dispatchTerminalCommandFinishedEvent(worktreeId, bestEffortExitCode)
      void retireForegroundAgentUnlessConfirmed()
      // Mirror SSH’s unprobed same-turn drop; local PTYs require mounted foreground confirmation against nested-shell 133;D.
      if (parseAppSshPtyId(ptyId) === null) {
        return
      }
      dropCommandFinishedStatusIfSameTurn(useAppStore.getState().agentStatusByPaneKey[paneKey])
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

    // Command Code renders its composer during tool work; require no active repaint before completing.
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
      // Release without flushing so reveal inherits the remaining settle time and can still cancel with a working repaint.
      releaseCommandCodeDoneSettleExecutor()
      disposed = true
    }
  }
}
