/**
 * Parked-pane command-lifecycle status policy.
 * Why: parking unmounts TerminalPane, so OSC 133;D and Command Code scrape signals went dark.
 * This ports the store-level subset of pty-connection's handlers; the pane-coupled parts
 * (foreground process-confirm ladder, key-intent interrupt inference) stay with the mounted pane.
 */
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { resolvePaneAgentOwner } from '../../../../shared/pane-agent-owner'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
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
import { canAgentOutputOwnPane } from './command-code-output-ownership'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type ParkedTerminalCommandStatusPolicy = {
  onCommandFinished: (bestEffortExitCode: number | null) => void
  onCommandCodeWorking: (prompt: string) => void
  onCommandCodeDone: (prompt: string) => void
  onAgentOutputWorking: (agent: TuiAgent, prompt: string) => void
  onAgentOutputDone: (agent: TuiAgent, prompt: string) => void
  onAgentOutputWaiting: (agent: TuiAgent, prompt: string) => void
  dispose: () => void
}

// Why only 'working': an in-flight turn is the one state a recreated detector can still
// resolve, and it proves the Command Code TUI is live — a stale 'done' row would arm the
// scrape against whatever process replaced it. Shared by parked watchers and the reveal
// remount, which both recreate the detector long past the banner.
export function readInFlightAgentOutputTurn(
  paneKey: string,
  agent: TuiAgent
): { prompt: string } | null {
  const entry = useAppStore.getState().agentStatusByPaneKey?.[paneKey]
  // Why: a 'waiting' row is also an unfinished turn the recreated detector must resolve.
  if (entry?.agentType !== agent || (entry.state !== 'working' && entry.state !== 'waiting')) {
    return null
  }
  return { prompt: entry.prompt }
}

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

  const canApplyAgentOutputStatus = (agent: TuiAgent): boolean => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[worktreeId] ?? []).find((entry) => entry.id === tabId)
    const foreground = state.paneForegroundAgentByPaneKey[paneKey]
    const paneOwnerAgent = resolvePaneAgentOwner({
      launchAgent: tab?.launchAgent,
      startupLaunchAgent: state.agentLaunchConfigByPaneKey[paneKey]?.identity.agentType,
      hookAgent: state.agentStatusByPaneKey[paneKey]?.agentType
    })
    return canAgentOutputOwnPane({
      agent,
      foregroundAgent: foreground?.agent,
      shellForeground: foreground?.shellForeground,
      paneOwnerAgent,
      retainedPaneOwnerAgent: state.retainedAgentsByPaneKey[paneKey]?.agentType
    })
  }

  // Port of pty-connection's dropCommandFinishedStatusIfSameTurn, minus the interrupt-inference
  // option: parked panes receive no key events, so inference never has evidence here.
  const dropCommandFinishedStatusIfSameTurn = (entry: AgentStatusEntry | undefined): void => {
    const state = useAppStore.getState()
    if (!entry) {
      // Why: an Orca-started agent can exit before its first hook status; clear the launch
      // registry on command exit like the mounted path does.
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
    state.dropAgentStatus(paneKey)
  }

  // Complete the row only while it is still this turn's command-code/working entry.
  const settleAgentOutputDone = (normalizedPrompt: string, agent: TuiAgent): void => {
    const routing = resolveRouting()
    if (!routing) {
      return
    }
    const currentState = useAppStore.getState()
    const currentEntry = currentState.agentStatusByPaneKey[paneKey]
    if (currentEntry?.agentType !== agent || currentEntry.state !== 'working') {
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
        agentType: agent,
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
    settleAgentOutputDone
  )

  const seedAgentOutputRow = (
    agent: TuiAgent,
    state: 'working' | 'waiting',
    prompt: string
  ): void => {
    if (!canApplyAgentOutputStatus(agent)) {
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
      currentEntry?.agentType === agent &&
      currentEntry.state === 'done' &&
      (!normalizedPrompt || normalizedPrompt === currentEntry.prompt.trim())
    ) {
      return
    }
    currentState.setAgentStatus(
      paneKey,
      {
        state,
        prompt:
          normalizedPrompt ||
          (currentEntry?.state === 'working' || currentEntry?.state === 'waiting'
            ? currentEntry.prompt
            : ''),
        agentType: agent,
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

  const scheduleAgentOutputDone = (agent: TuiAgent, prompt: string): void => {
    if (!canApplyAgentOutputStatus(agent)) {
      return
    }
    const normalizedPrompt = prompt.trim()
    if (!normalizedPrompt) {
      cancelCommandCodeDoneSettle(paneKey)
      return
    }
    openCommandCodeDoneSettle(paneKey, normalizedPrompt, agent)
  }

  return {
    onCommandFinished: (bestEffortExitCode: number | null): void => {
      if (disposed) {
        return
      }
      // Why: the finished command may have moved HEAD or the index (an agent running
      // `git checkout` in a parked worktree); nudge git UI now instead of waiting for a poll.
      dispatchTerminalCommandFinishedEvent(worktreeId, bestEffortExitCode)
      // Why: drop the same-turn status row only for SSH PTYs — exact parity with the mounted
      // path, whose foreground tracker refuses SSH ids and drops un-probed. Local PTYs need
      // pty-connection's process-confirm ladder to tell a leaked nested-shell 133;D from a
      // real agent exit, so their drop stays with the mounted pane.
      if (parseAppSshPtyId(ptyId) === null) {
        return
      }
      dropCommandFinishedStatusIfSameTurn(useAppStore.getState().agentStatusByPaneKey[paneKey])
    },

    onCommandCodeWorking: (prompt: string): void => {
      seedAgentOutputRow('command-code', 'working', prompt)
    },

    // Why the settle: these TUIs keep rendering the composer while tools run, so
    // only complete the row if no active repaint arrives within the window.
    onCommandCodeDone: (prompt: string): void => {
      scheduleAgentOutputDone('command-code', prompt)
    },

    onAgentOutputWorking: (agent: TuiAgent, prompt: string): void => {
      seedAgentOutputRow(agent, 'working', prompt)
    },

    onAgentOutputDone: (agent: TuiAgent, prompt: string): void => {
      scheduleAgentOutputDone(agent, prompt)
    },

    onAgentOutputWaiting: (agent: TuiAgent, prompt: string): void => {
      seedAgentOutputRow(agent, 'waiting', prompt)
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
