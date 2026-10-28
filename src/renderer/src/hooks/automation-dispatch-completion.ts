import {
  createAutomationRunOutputSnapshotBuffer,
  selectAutomationRunOutputSnapshot
} from '@/components/automations/automation-run-output-snapshot'
import { useAppStore } from '@/store'
import type {
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../../shared/automations-types'
import type { AgentStateHistoryEntry, AgentStatusEntry } from '../../../shared/agent-status-types'
import { agentMainAgentVerdict } from '../../../shared/agent-main-agent-verdict'
import type { AgentTurnOutcome } from '../../../shared/agent-turn-outcome'
import {
  getAgentStateHistoryOverlap,
  selectAutomationAgentStatusEntryChange,
  UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY
} from './automation-agent-status-entry-change'
import type { Worktree } from '../../../shared/worktree/types'
import { isProvenProcessExit } from '../../../shared/terminal-exit-cause'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'

type MarkDispatchResult = (result: AutomationDispatchResult) => Promise<void>

export function createAutomationDispatchCompletion(args: {
  run: AutomationRun
  worktree: Worktree
  precheckResult: AutomationPrecheckResult | null
  markDispatchResult: MarkDispatchResult
  releaseTerminalOwnership: () => void
  finalizeTerminalOwnership: AutomationTerminalOwnership['finalize']
}) {
  const outputSnapshotBuffer = createAutomationRunOutputSnapshotBuffer()
  let latestAssistantMessage: string | null = null
  const getOutputSnapshot = () =>
    selectAutomationRunOutputSnapshot(latestAssistantMessage, outputSnapshotBuffer.snapshot())
  let dispatchMarked = false
  let pendingExitCode: number | null = null
  let pendingDone = false
  let pendingDoneOutcome: AgentTurnOutcome | undefined
  let completionMarked = false
  let contactLost = false
  let unsubscribeAgentStatus = (): void => {}
  let unsubscribeSessionObserver = (): void => {}
  let releaseReuseDispatchTab = (): void => {}
  const cleanupRunObservers = (): void => {
    unsubscribeAgentStatus()
    unsubscribeSessionObserver()
    releaseReuseDispatchTab()
    unsubscribeAgentStatus = (): void => {}
    unsubscribeSessionObserver = (): void => {}
    releaseReuseDispatchTab = (): void => {}
  }
  const markCompletionResult = async (outcome?: AgentTurnOutcome): Promise<void> => {
    if (completionMarked) {
      return
    }
    completionMarked = true
    cleanupRunObservers()
    const failedOutcome =
      outcome && outcome !== 'success' && outcome !== 'unconfirmed' ? outcome : null
    try {
      await args.markDispatchResult({
        runId: args.run.id,
        status: failedOutcome ? 'dispatch_failed' : 'completed',
        workspaceId: args.worktree.id,
        workspaceDisplayName: args.worktree.displayName,
        outputSnapshot: getOutputSnapshot(),
        precheckResult: args.precheckResult,
        error: failedOutcome ? `Automation agent turn ended with ${failedOutcome}.` : null
      })
    } catch (error) {
      args.releaseTerminalOwnership()
      throw error
    }
    if (failedOutcome) {
      args.releaseTerminalOwnership()
    } else {
      await retireRunTerminal()
    }
  }
  const retireRunTerminal = async (): Promise<void> => {
    const retirement = await args.finalizeTerminalOwnership({
      // Why: only a workspace made for this run is its own; a shared one would gather a sleeping tab per run.
      preservePane: args.worktree.automationProvenance?.automationRunId === args.run.id
    })
    if (!retirement) {
      return
    }
    // Clear stopped-process pointers best-effort; sleeping panes retain resumable tab/pane keys for View run.
    try {
      await args.markDispatchResult({
        runId: args.run.id,
        status: 'completed',
        ...(retirement === 'closed' ? { terminalSessionId: null, terminalPaneKey: null } : {}),
        terminalPtyId: null
      })
    } catch (error) {
      console.error('[automations] Failed to clear retired terminal identity:', error)
    }
  }
  /** Lost PTY contact proves no result: retain dispatched state and let main’s watcher report lost-terminal evidence. Never finalize or close unproven-dead work, which could orphan a live remote process. */
  const abandonUnverifiableRun = (code: number): void => {
    if (completionMarked || contactLost) {
      return
    }
    contactLost = true
    cleanupRunObservers()
    args.releaseTerminalOwnership()
    console.warn(
      `[automations] Lost contact with the process for run ${args.run.id} (code ${code}); leaving the run dispatched rather than reporting an exit.`
    )
  }
  const markExitResult = async (code: number): Promise<void> => {
    if (completionMarked) {
      return
    }
    if (!isProvenProcessExit(code)) {
      abandonUnverifiableRun(code)
      return
    }
    completionMarked = true
    cleanupRunObservers()
    try {
      await args.markDispatchResult({
        runId: args.run.id,
        status: code === 0 ? 'completed' : 'dispatch_failed',
        workspaceId: args.worktree.id,
        workspaceDisplayName: args.worktree.displayName,
        outputSnapshot: getOutputSnapshot(),
        precheckResult: args.precheckResult,
        error: code === 0 ? null : `Automation process exited with code ${code}.`
      })
    } catch (error) {
      args.releaseTerminalOwnership()
      throw error
    }
    if (code === 0) {
      await retireRunTerminal()
    } else {
      args.releaseTerminalOwnership()
    }
  }
  const settleLateResult = (result: Promise<void>): void => {
    // Status/exit callbacks have no awaitable caller; release ownership before persistence failures propagate.
    void result.catch((error) => {
      console.error('[automations] Failed to persist late automation result:', error)
    })
  }
  const handleAgentDone = (outcome?: AgentTurnOutcome): void => {
    if (completionMarked || outcome === 'unconfirmed') {
      return
    }
    if (!dispatchMarked) {
      pendingDone = true
      if (outcome !== undefined) {
        pendingDoneOutcome = outcome
      }
      return
    }
    settleLateResult(markCompletionResult(outcome))
  }
  const handleExit = (code: number): void => {
    if (completionMarked) {
      return
    }
    if (!dispatchMarked) {
      pendingExitCode = code
      return
    }
    settleLateResult(markExitResult(code))
  }
  const observeAgentStatus = (
    targetPaneKey: string,
    startedAfter: number,
    options?: { requireWorkingAfterStart?: boolean }
  ): void => {
    let sawWorkingAfterStart = false
    let observedStateHistory: AgentStateHistoryEntry[] = []
    let observedEntry: AgentStatusEntry | undefined
    const checkCurrentStatus = (): void => {
      const entryChange = selectAutomationAgentStatusEntryChange(
        useAppStore.getState().agentStatusByPaneKey,
        targetPaneKey,
        observedEntry
      )
      if (entryChange === UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY) {
        return
      }
      const entry = entryChange
      observedEntry = entry
      if (!entry || entry.updatedAt < startedAfter) {
        return
      }
      const historyOverlap = getAgentStateHistoryOverlap(observedStateHistory, entry.stateHistory)
      // Keep sawWorkingAfterStart monotonic: recreated entries lose history and cannot rederive the edge needed by reuseSession.
      for (const historicalState of entry.stateHistory.slice(historyOverlap)) {
        if (historicalState.startedAt < startedAfter) {
          continue
        }
        if (historicalState.state === 'working') {
          sawWorkingAfterStart = true
        }
        if (
          historicalState.state === 'done' &&
          (!options?.requireWorkingAfterStart || sawWorkingAfterStart)
        ) {
          const historicalVerdict = agentMainAgentVerdict(historicalState)
          if (historicalVerdict === 'unconfirmed') {
            continue
          }
          // Why: this `done` already rolled out of the live entry, so its output
          // survives only in the entry-level completed slot.
          latestAssistantMessage =
            entry.lastCompletedAssistantMessage?.trim() || latestAssistantMessage
          handleAgentDone(historicalVerdict ?? undefined)
          return
        }
      }
      observedStateHistory = [...entry.stateHistory]
      if (entry.state === 'working') {
        sawWorkingAfterStart = true
      }
      if (
        entry.state === 'done' &&
        // SessionStart boundary-done means connection before prompt submission; finishing here would record empty output and close the new tab.
        entry.sessionBoundary !== true &&
        (!options?.requireWorkingAfterStart || sawWorkingAfterStart)
      ) {
        const liveVerdict = agentMainAgentVerdict(entry)
        if (liveVerdict === 'unconfirmed') {
          return
        }
        latestAssistantMessage = entry.lastAssistantMessage?.trim() || latestAssistantMessage
        handleAgentDone(liveVerdict ?? undefined)
      }
    }
    // Codex/Claude completion normally comes from global hook IPC rather than hidden PTY OSC.
    unsubscribeAgentStatus = useAppStore.subscribe(checkCurrentStatus)
    checkCurrentStatus()
  }

  return {
    appendOutput: (chunk: string) => outputSnapshotBuffer.append(chunk),
    captureAssistantMessage: (message: string | null | undefined) => {
      latestAssistantMessage = message?.trim() || latestAssistantMessage
    },
    cleanupRunObservers,
    handleAgentDone,
    handleExit,
    observeAgentStatus,
    setReuseDispatchTabRelease: (release: () => void) => {
      releaseReuseDispatchTab = release
    },
    setSessionObserver: (unsubscribe: () => void) => {
      unsubscribeSessionObserver = unsubscribe
    },
    settlePendingAfterDispatch: async () => {
      dispatchMarked = true
      if (pendingDone) {
        await markCompletionResult(pendingDoneOutcome)
      } else if (pendingExitCode !== null) {
        await markExitResult(pendingExitCode)
      }
    }
  }
}
