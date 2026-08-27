/* eslint-disable max-lines -- Why: automation dispatch is a single renderer lifecycle
 * coordinator spanning workspace creation, SSH readiness, terminal launch/reuse,
 * completion bookkeeping, and focus restoration. */
import { useEffect } from 'react'
import { launchAgentBackgroundSession } from '@/lib/launch-agent-background-session'
import { submitPromptToAgentPty } from '@/lib/agent-paste-draft'
import { findReusableAutomationSession } from '@/lib/automation-session-reuse'
import { observeExistingAutomationSession } from '@/lib/automation-session-observer'
import { launchWorktreeBackgroundTerminals } from '@/lib/launch-worktree-background-terminals'
import { useAppStore } from '@/store'
import type {
  AutomationDispatchResult,
  AutomationPrecheckResult
} from '../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../../shared/automation-precheck'
import {
  createAutomationRunOutputSnapshotBuffer,
  selectAutomationRunOutputSnapshot
} from '@/components/automations/automation-run-output-snapshot'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { listAutomationRunsForTarget } from '@/components/automations/automation-host-client'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AgentStateHistoryEntry } from '../../../shared/agent-status-types'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspace-execution-host'

const activeReuseDispatchTabIds = new Set<string>()

function acquireReuseDispatchTab(tabId: string): (() => void) | null {
  if (activeReuseDispatchTabIds.has(tabId)) {
    return null
  }
  activeReuseDispatchTabIds.add(tabId)
  return () => activeReuseDispatchTabIds.delete(tabId)
}

function buildAutomationWorkspaceName(runTitle: string, scheduledFor: number): string {
  const slug = runTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const stamp = new Date(scheduledFor).toISOString().replace(/[-:]/g, '').slice(0, 13)
  return `auto-${slug || 'run'}-${stamp}`
}

function agentStateHistoryEntriesEqual(
  left: AgentStateHistoryEntry,
  right: AgentStateHistoryEntry
): boolean {
  return (
    left.state === right.state &&
    left.prompt === right.prompt &&
    left.startedAt === right.startedAt &&
    left.interrupted === right.interrupted
  )
}

function getAgentStateHistoryOverlap(
  previous: AgentStateHistoryEntry[],
  current: AgentStateHistoryEntry[]
): number {
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap -= 1) {
    const previousOffset = previous.length - overlap
    if (
      current
        .slice(0, overlap)
        .every((entry, index) =>
          agentStateHistoryEntriesEqual(entry, previous[previousOffset + index])
        )
    ) {
      return overlap
    }
  }
  return 0
}

export function useAutomationDispatchEvents(): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onDispatchRequested(
      async ({ automation, run, dispatchToken }) => {
        const markDispatchResult = async (result: AutomationDispatchResult): Promise<void> => {
          // Deliberately no local emit: the write publishes its own host-scoped event
          // (automation-run-writer.ts) before this reply returns, and an unscoped one
          // here would arrive second and invalidate every host in the catalog.
          await window.api.automations.markDispatchResult(result)
        }
        const state = useAppStore.getState()
        const focusBeforeDispatch = {
          activeView: state.activeView,
          activeWorktreeId: state.activeWorktreeId,
          activeTabId: state.activeTabId,
          activeTabType: state.activeTabType
        }
        const runRepoId = getAutomationRunRepoId(automation)
        const repo = state.repos.find((entry) => entry.id === runRepoId)
        const automationWorkspaceScope = parseWorkspaceKey(automation.workspaceId ?? '')
        const automationWorktree = automation.workspaceId
          ? automationWorkspaceScope?.type === 'folder'
            ? state.getKnownWorktreeById(automation.workspaceId)
            : state.allWorktrees().find((entry) => entry.id === automation.workspaceId)
          : null
        let dispatchWorkspaceId = automation.workspaceId
        let dispatchWorkspaceDisplayName =
          automationWorktree?.displayName ?? run.workspaceDisplayName ?? null
        let precheckResult: AutomationPrecheckResult | null = null
        let terminalOwnership: AutomationTerminalOwnership | null = null
        const releaseTerminalOwnership = (): void => {
          const ownership = terminalOwnership
          terminalOwnership = null
          ownership?.release()
        }
        const finalizeTerminalOwnership = (): boolean => {
          const ownership = terminalOwnership
          terminalOwnership = null
          return ownership?.finalize() ?? false
        }

        if (!repo) {
          await markDispatchResult({
            runId: run.id,
            status: 'skipped_unavailable',
            workspaceId: run.workspaceId,
            workspaceDisplayName: run.workspaceDisplayName ?? null,
            error: translate(
              'auto.hooks.useAutomationDispatchEvents.386db94f3e',
              'The target project is no longer available.'
            )
          })
          return
        }

        try {
          const folderWorkspaceHost =
            automationWorkspaceScope?.type === 'folder'
              ? resolveFolderWorkspaceHost(state, automationWorkspaceScope.folderWorkspaceId)
              : null
          const folderWorkspaceConnectionId =
            folderWorkspaceHost?.kind === 'ssh' ? folderWorkspaceHost.targetId : null
          // A workspace whose host does not resolve to one place is refused, not guessed at.
          const folderWorkspaceHostUnresolved =
            folderWorkspaceHost !== null && folderWorkspaceHost.kind === 'ambiguous'
          const folderWorkspaceHostId =
            folderWorkspaceHost && automationWorktree
              ? folderWorkspaceConnectionId
                ? toSshExecutionHostId(folderWorkspaceConnectionId)
                : folderWorkspaceHost.kind === 'local'
                  ? getResolvedExecutionHostIdForWorktree(state, automationWorktree.id)
                  : null
              : null
          const runHostId =
            parseExecutionHostId(automation.runContext?.hostId)?.id ?? getRepoExecutionHostId(repo)
          const workspaceMatchesRunTarget =
            automationWorkspaceScope?.type === 'folder'
              ? folderWorkspaceHostId !== null && folderWorkspaceHostId === runHostId
              : !automation.runContext?.repoId ||
                automationWorktree?.repoId === automation.runContext.repoId
          if (
            automation.workspaceMode === 'existing' &&
            automationWorktree &&
            !workspaceMatchesRunTarget
          ) {
            await markDispatchResult({
              runId: run.id,
              status: 'skipped_unavailable',
              workspaceId: automation.workspaceId,
              workspaceDisplayName: dispatchWorkspaceDisplayName,
              error: folderWorkspaceHostUnresolved
                ? translate(
                    'auto.hooks.useAutomationDispatchEvents.workspaceHostUnresolved',
                    'The target workspace spans more than one host, so this run has no single host to use.'
                  )
                : translate(
                    'auto.hooks.useAutomationDispatchEvents.3ad7d77f57',
                    'The target workspace is on a different host than this automation run target.'
                  )
            })
            return
          }
          const sshTargetId =
            automationWorkspaceScope?.type === 'folder'
              ? (folderWorkspaceConnectionId ?? null)
              : (repo.connectionId ?? null)
          if (sshTargetId) {
            const needsPrompt = await window.api.ssh.needsPassphrasePrompt({
              targetId: sshTargetId
            })
            if (needsPrompt) {
              await markDispatchResult({
                runId: run.id,
                status: 'skipped_needs_interactive_auth',
                workspaceId: dispatchWorkspaceId,
                workspaceDisplayName: dispatchWorkspaceDisplayName,
                error: translate(
                  'auto.hooks.useAutomationDispatchEvents.16a21d6413',
                  'SSH reconnect requires interactive credentials.'
                )
              })
              return
            }
            const sshState = await window.api.ssh.getState({ targetId: sshTargetId })
            if (sshState?.status !== 'connected') {
              try {
                const connected = await window.api.ssh.connect({ targetId: sshTargetId })
                if (connected?.status !== 'connected') {
                  throw new Error('SSH target is unavailable.')
                }
              } catch (error) {
                await markDispatchResult({
                  runId: run.id,
                  status: 'skipped_unavailable',
                  workspaceId: dispatchWorkspaceId,
                  workspaceDisplayName: dispatchWorkspaceDisplayName,
                  error: error instanceof Error ? error.message : String(error)
                })
                return
              }
            }
          }

          if (automation.workspaceMode === 'existing' && !automationWorktree) {
            await markDispatchResult({
              runId: run.id,
              status: 'skipped_unavailable',
              workspaceId: automation.workspaceId,
              workspaceDisplayName: dispatchWorkspaceDisplayName,
              error: translate(
                'auto.hooks.useAutomationDispatchEvents.59718b120b',
                'The target workspace is no longer available.'
              )
            })
            return
          }

          if (run.trigger === 'scheduled' && automation.precheck) {
            precheckResult = await window.api.automations.runPrecheck({
              automationId: automation.id,
              runId: run.id
            })
            if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
              await markDispatchResult({
                runId: run.id,
                status: 'skipped_precheck',
                workspaceId: dispatchWorkspaceId,
                workspaceDisplayName: dispatchWorkspaceDisplayName,
                precheckResult,
                error: formatAutomationPrecheckFailure(precheckResult)
              })
              return
            }
          }

          const automationWorkspaceCreateRequestId = createBrowserUuid()
          const createResult =
            automation.workspaceMode === 'new_per_run'
              ? await useAppStore.getState().createWorktree(
                  runRepoId,
                  buildAutomationWorkspaceName(run.title, run.scheduledFor),
                  automation.baseBranch ?? undefined,
                  automation.setupDecision ?? 'skip',
                  undefined,
                  'unknown',
                  run.title,
                  undefined,
                  undefined,
                  undefined,
                  // Why: the automation session below owns the prompt-bearing
                  // agent tab; createdWithAgent would reopen an empty fallback.
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  {
                    automationProvenanceRequest: {
                      automationId: automation.id,
                      automationRunId: run.id,
                      dispatchToken,
                      createRequestId: automationWorkspaceCreateRequestId
                    }
                  }
                )
              : null
          const worktree = createResult
            ? createResult.worktree
            : automation.workspaceId
              ? automationWorktree
              : null

          if (!worktree) {
            await markDispatchResult({
              runId: run.id,
              status: 'skipped_unavailable',
              workspaceId: automation.workspaceId,
              workspaceDisplayName: dispatchWorkspaceDisplayName,
              error: translate(
                'auto.hooks.useAutomationDispatchEvents.59718b120b',
                'The target workspace is no longer available.'
              )
            })
            return
          }
          dispatchWorkspaceId = worktree.id
          dispatchWorkspaceDisplayName = worktree.displayName
          if (createResult?.setup || createResult?.defaultTabs) {
            void launchWorktreeBackgroundTerminals({
              worktreeId: worktree.id,
              setup: createResult.setup,
              defaultTabs: createResult.defaultTabs
            }).catch((error) => {
              // Why: setup/defaultTabs match normal worktree creation: they are
              // best-effort terminal work and must not block the automation agent.
              console.warn('[automations] Failed to launch workspace setup/default tabs:', error)
            })
          }

          const outputSnapshotBuffer = createAutomationRunOutputSnapshotBuffer()
          let latestAssistantMessage: string | null = null
          const getOutputSnapshot = () =>
            selectAutomationRunOutputSnapshot(
              latestAssistantMessage,
              outputSnapshotBuffer.snapshot()
            )
          let dispatchMarked = false
          let pendingExitCode: number | null = null
          let pendingDone = false
          let completionMarked = false
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
          const markCompletionResult = async (): Promise<void> => {
            if (completionMarked) {
              return
            }
            completionMarked = true
            cleanupRunObservers()
            try {
              await markDispatchResult({
                runId: run.id,
                status: 'completed',
                workspaceId: worktree.id,
                workspaceDisplayName: worktree.displayName,
                outputSnapshot: getOutputSnapshot(),
                precheckResult,
                error: null
              })
            } catch (error) {
              releaseTerminalOwnership()
              throw error
            }
            if (finalizeTerminalOwnership()) {
              await clearRetiredRunTerminalIdentity()
            }
          }
          const clearRetiredRunTerminalIdentity = async (): Promise<void> => {
            // Why: the owned terminal was just retired, so the run's pane/pty
            // pointers now reference a closed tab. Drop them (best-effort) so
            // "View run" resolves to the workspace/snapshot instead of dead-ending
            // on an unavailable terminal.
            try {
              await markDispatchResult({
                runId: run.id,
                status: 'completed',
                terminalSessionId: null,
                terminalPaneKey: null,
                terminalPtyId: null
              })
            } catch (error) {
              console.error('[automations] Failed to clear retired terminal identity:', error)
            }
          }
          const markExitResult = async (code: number): Promise<void> => {
            if (completionMarked) {
              return
            }
            completionMarked = true
            cleanupRunObservers()
            try {
              await markDispatchResult({
                runId: run.id,
                status: code === 0 ? 'completed' : 'dispatch_failed',
                workspaceId: worktree.id,
                workspaceDisplayName: worktree.displayName,
                outputSnapshot: getOutputSnapshot(),
                precheckResult,
                error: code === 0 ? null : `Automation process exited with code ${code}.`
              })
            } catch (error) {
              releaseTerminalOwnership()
              throw error
            }
            if (code === 0) {
              if (finalizeTerminalOwnership()) {
                await clearRetiredRunTerminalIdentity()
              }
            } else {
              releaseTerminalOwnership()
            }
          }
          const settleLateResult = (result: Promise<void>): void => {
            // Why: status/exit callbacks have no awaitable caller; the result
            // path already releases ownership before propagating persistence errors.
            void result.catch((error) => {
              console.error('[automations] Failed to persist late automation result:', error)
            })
          }
          const handleAgentDone = (): void => {
            if (completionMarked) {
              return
            }
            if (!dispatchMarked) {
              pendingDone = true
              return
            }
            settleLateResult(markCompletionResult())
          }
          const observeAgentStatus = (
            targetPaneKey: string,
            startedAfter: number,
            options?: { requireWorkingAfterStart?: boolean }
          ): void => {
            let sawWorkingAfterStart = false
            let observedStateHistory: AgentStateHistoryEntry[] = []
            const checkCurrentStatus = (): void => {
              const { agentStatusByPaneKey } = useAppStore.getState()
              for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
                if (paneKey !== targetPaneKey || entry.updatedAt < startedAfter) {
                  continue
                }
                const historyOverlap = getAgentStateHistoryOverlap(
                  observedStateHistory,
                  entry.stateHistory
                )
                // Why: sawWorkingAfterStart stays monotonic — a recreated entry
                // (transport loss, PTY exit, cap eviction) arrives with an empty
                // stateHistory, so clearing it here would strand reuseSession runs
                // with nothing left to re-derive the working edge from.
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
                    // Why: this `done` already rolled out of the live entry, so its output
                    // survives only in the entry-level completed slot.
                    latestAssistantMessage =
                      entry.lastCompletedAssistantMessage?.trim() || latestAssistantMessage
                    handleAgentDone()
                    return
                  }
                }
                observedStateHistory = [...entry.stateHistory]
                if (entry.state === 'working') {
                  sawWorkingAfterStart = true
                }
                if (
                  entry.state === 'done' &&
                  // Why: a session-boundary done is the agent CONNECTING (Claude SessionStart
                  // fires at launch, before the argv prompt submits) — completing here would
                  // close the tab and record an empty run result.
                  entry.sessionBoundary !== true &&
                  (!options?.requireWorkingAfterStart || sawWorkingAfterStart)
                ) {
                  latestAssistantMessage =
                    entry.lastAssistantMessage?.trim() || latestAssistantMessage
                  handleAgentDone()
                  return
                }
              }
            }
            // Why: Codex/Claude completion normally arrives through the global
            // hook IPC listener, not the hidden PTY OSC fallback.
            unsubscribeAgentStatus = useAppStore.subscribe(checkCurrentStatus)
            checkCurrentStatus()
          }
          const dispatchStartedAt = Date.now()
          if (automation.reuseSession) {
            const reusableSession = findReusableAutomationSession({
              automationId: automation.id,
              agentId: automation.agentId,
              worktreeId: worktree.id,
              currentRunId: run.id,
              // Why: the dispatch loop only ever executes for the desktop authority,
              // so its history read addresses the local runtime explicitly.
              runs: await listAutomationRunsForTarget({ kind: 'local' }, automation.id),
              state: useAppStore.getState()
            })
            if (reusableSession) {
              const releaseTab = acquireReuseDispatchTab(reusableSession.tabId)
              if (releaseTab) {
                releaseReuseDispatchTab = releaseTab
                try {
                  const submitted = await submitPromptToAgentPty({
                    tabId: reusableSession.tabId,
                    ptyId: reusableSession.ptyId,
                    content: automation.prompt
                  })
                  if (!submitted) {
                    cleanupRunObservers()
                  } else {
                    let reuseSawWorking = false
                    const handleReusableAgentStatus = (payload: { state: string }): void => {
                      if (payload.state === 'working') {
                        reuseSawWorking = true
                        return
                      }
                      if (payload.state === 'done' && reuseSawWorking) {
                        handleAgentDone()
                      }
                    }
                    const reuseCompletionStartedAt = Date.now()
                    unsubscribeSessionObserver = await observeExistingAutomationSession({
                      ptyId: reusableSession.ptyId,
                      paneKey: reusableSession.paneKey,
                      runId: run.id,
                      onData: (chunk) => {
                        outputSnapshotBuffer.append(chunk)
                      },
                      onAgentStatus: (payload) => {
                        latestAssistantMessage =
                          payload.lastAssistantMessage?.trim() || latestAssistantMessage
                        handleReusableAgentStatus(payload)
                      },
                      onExit: (code) => {
                        if (completionMarked) {
                          return
                        }
                        if (!dispatchMarked) {
                          pendingExitCode = code
                          return
                        }
                        settleLateResult(markExitResult(code))
                      }
                    })
                    observeAgentStatus(reusableSession.paneKey, reuseCompletionStartedAt, {
                      requireWorkingAfterStart: true
                    })
                    await markDispatchResult({
                      runId: run.id,
                      status: 'dispatched',
                      workspaceId: worktree.id,
                      workspaceDisplayName: worktree.displayName,
                      terminalSessionId: reusableSession.tabId,
                      terminalPaneKey: reusableSession.paneKey,
                      terminalPtyId: reusableSession.ptyId,
                      precheckResult,
                      error: null
                    })
                    dispatchMarked = true
                    if (pendingDone) {
                      await markCompletionResult()
                    } else if (pendingExitCode !== null) {
                      await markExitResult(pendingExitCode)
                    }
                    return
                  }
                } catch (error) {
                  cleanupRunObservers()
                  throw error
                }
              }
            }
          }
          const result = await launchAgentBackgroundSession({
            agent: automation.agentId,
            worktreeId: worktree.id,
            prompt: automation.prompt,
            launchSource: 'unknown',
            title: run.title,
            onData: (chunk) => {
              outputSnapshotBuffer.append(chunk)
            },
            onAgentStatus: (payload) => {
              latestAssistantMessage =
                payload.lastAssistantMessage?.trim() || latestAssistantMessage
              // Why: session-boundary done = launch connect, not run completion (see observeAgentStatus).
              if (payload.state !== 'done' || payload.sessionBoundary === true) {
                return
              }
              handleAgentDone()
            },
            onExit: (_ptyId, code) => {
              if (completionMarked) {
                return
              }
              if (!dispatchMarked) {
                pendingExitCode = code
                return
              }
              settleLateResult(markExitResult(code))
            }
          })
          if (!result) {
            throw new Error('Unable to build an agent launch plan.')
          }
          terminalOwnership = result.terminalOwnership
          if (automation.reuseSession) {
            // Why: the first fresh launch is the seed for later reuse and must
            // survive completion under the same policy as an already-reused tab.
            releaseTerminalOwnership()
          }
          const launchedTabId = result.tabId
          observeAgentStatus(result.paneKey, dispatchStartedAt)
          try {
            await markDispatchResult({
              runId: run.id,
              status: 'dispatched',
              workspaceId: worktree.id,
              workspaceDisplayName: worktree.displayName,
              terminalSessionId: launchedTabId,
              terminalPaneKey: result.paneKey,
              terminalPtyId: result.ptyId,
              precheckResult,
              error: null
            })
            dispatchMarked = true
            if (pendingDone) {
              await markCompletionResult()
            } else if (pendingExitCode !== null) {
              await markExitResult(pendingExitCode)
            }
          } catch (error) {
            cleanupRunObservers()
            throw error
          }
          const currentState = useAppStore.getState()
          // Why: Run Now and scheduled dispatches should create workspaces/tabs in
          // the background; only an explicit row click should navigate there.
          if (
            focusBeforeDispatch.activeWorktreeId !== worktree.id &&
            currentState.activeWorktreeId === worktree.id
          ) {
            currentState.setActiveView(focusBeforeDispatch.activeView)
            currentState.setActiveWorktree(focusBeforeDispatch.activeWorktreeId)
            if (focusBeforeDispatch.activeTabId) {
              currentState.setActiveTab(focusBeforeDispatch.activeTabId)
            }
            currentState.setActiveTabType(focusBeforeDispatch.activeTabType)
          }
        } catch (error) {
          releaseTerminalOwnership()
          await markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            workspaceId: dispatchWorkspaceId,
            workspaceDisplayName: dispatchWorkspaceDisplayName,
            precheckResult,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    )
    void window.api.automations.rendererReady()
    return unsubscribe
  }, [])
}
