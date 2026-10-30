import { listAutomationRunsForTarget } from '@/components/automations/automation-host-client'
import { translate } from '@/i18n/i18n'
import { submitPromptToAgentPty } from '@/lib/agent-paste-draft'
import { launchAgentBackgroundSession } from '@/lib/launch-agent-background-session'
import { observeExistingAutomationSession } from '@/lib/automation-session-observer'
import { findReusableAutomationSession } from '@/lib/automation-session-reuse'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'
import { useAppStore } from '@/store'
import { captureWorkspaceSelection, restoreWorkspaceSelection } from '@/lib/active-workspace-host'
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult
} from '../../../shared/automations-types'
import { createAutomationDispatchCompletion } from './automation-dispatch-completion'
import {
  prepareAutomationDispatchWorkspace,
  resolveAutomationDispatchWorkspace
} from './automation-dispatch-workspace'

const activeReuseDispatchTabIds = new Set<string>()

function acquireReuseDispatchTab(tabId: string): (() => void) | null {
  if (activeReuseDispatchTabIds.has(tabId)) {
    return null
  }
  activeReuseDispatchTabIds.add(tabId)
  return () => activeReuseDispatchTabIds.delete(tabId)
}

export async function handleAutomationDispatchRequest({
  automation,
  run,
  dispatchToken
}: AutomationDispatchRequest): Promise<void> {
  const markDispatchResult = async (result: AutomationDispatchResult): Promise<void> => {
    // The writer publishes host-scoped change before reply; another unscoped emit would invalidate every host.
    await window.api.automations.markDispatchResult(result)
  }
  const state = useAppStore.getState()
  const focusBeforeDispatch = {
    activeView: state.activeView,
    activeWorktreeId: state.activeWorktreeId,
    selection: captureWorkspaceSelection(state),
    activeTabId: state.activeTabId,
    activeTabType: state.activeTabType
  }
  const resolved = resolveAutomationDispatchWorkspace(state, automation, run)
  let terminalOwnership: AutomationTerminalOwnership | null = null
  const releaseTerminalOwnership = (): void => {
    const ownership = terminalOwnership
    terminalOwnership = null
    ownership?.release()
  }
  const finalizeTerminalOwnership: AutomationTerminalOwnership['finalize'] = async (options) => {
    const ownership = terminalOwnership
    terminalOwnership = null
    return (await ownership?.finalize(options)) ?? null
  }

  if (!resolved.repo) {
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
    const worktree = await prepareAutomationDispatchWorkspace({
      state,
      automation,
      run,
      dispatchToken,
      resolved: { ...resolved, repo: resolved.repo },
      markDispatchResult
    })
    if (!worktree) {
      return
    }
    const completion = createAutomationDispatchCompletion({
      run,
      worktree,
      precheckResult: resolved.context.precheckResult,
      markDispatchResult,
      releaseTerminalOwnership,
      finalizeTerminalOwnership
    })
    const dispatchStartedAt = Date.now()
    if (automation.reuseSession) {
      const reusableSession = findReusableAutomationSession({
        automationId: automation.id,
        agentId: automation.agentId,
        worktreeId: worktree.id,
        currentRunId: run.id,
        // Dispatch runs only on desktop authority, so history reads explicitly target the local runtime.
        runs: await listAutomationRunsForTarget({ kind: 'local' }, automation.id),
        state: useAppStore.getState()
      })
      if (reusableSession) {
        const releaseTab = acquireReuseDispatchTab(reusableSession.tabId)
        if (releaseTab) {
          completion.setReuseDispatchTabRelease(releaseTab)
          try {
            const submitted = await submitPromptToAgentPty({
              tabId: reusableSession.tabId,
              ptyId: reusableSession.ptyId,
              content: automation.prompt
            })
            if (!submitted) {
              completion.cleanupRunObservers()
            } else {
              let reuseSawWorking = false
              const handleReusableAgentStatus = (payload: { state: string }): void => {
                if (payload.state === 'working') {
                  reuseSawWorking = true
                  return
                }
                if (payload.state === 'done' && reuseSawWorking) {
                  completion.handleAgentDone()
                }
              }
              const reuseCompletionStartedAt = Date.now()
              completion.setSessionObserver(
                await observeExistingAutomationSession({
                  ptyId: reusableSession.ptyId,
                  paneKey: reusableSession.paneKey,
                  runId: run.id,
                  onData: completion.appendOutput,
                  onAgentStatus: (payload) => {
                    completion.captureAssistantMessage(payload.lastAssistantMessage)
                    handleReusableAgentStatus(payload)
                  },
                  onExit: completion.handleExit
                })
              )
              completion.observeAgentStatus(reusableSession.paneKey, reuseCompletionStartedAt, {
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
                precheckResult: resolved.context.precheckResult,
                error: null
              })
              await completion.settlePendingAfterDispatch()
              return
            }
          } catch (error) {
            completion.cleanupRunObservers()
            throw error
          }
        }
      }
    }
    const result = await launchAgentBackgroundSession({
      agent: automation.agentId,
      worktreeId: worktree.id,
      prompt: automation.prompt,
      ...(automation.extraAgentArgs ? { extraAgentArgs: automation.extraAgentArgs } : {}),
      launchSource: 'unknown',
      title: run.title,
      onData: completion.appendOutput,
      onAgentStatus: (payload) => {
        completion.captureAssistantMessage(payload.lastAssistantMessage)
        // Why: session-boundary done = launch connect, not run completion (see observeAgentStatus).
        if (payload.state !== 'done' || payload.sessionBoundary === true) {
          return
        }
        completion.handleAgentDone()
      },
      onExit: (_ptyId, code) => {
        completion.handleExit(code)
      }
    })
    if (!result) {
      throw new Error('Unable to build an agent launch plan.')
    }
    terminalOwnership = result.terminalOwnership
    completion.setSessionObserver(result.releaseRuntimeObservers)
    if (automation.reuseSession) {
      // Preserve the first fresh-launch seed under the same completion policy as reused tabs.
      releaseTerminalOwnership()
    }
    const launchedTabId = result.tabId
    completion.observeAgentStatus(result.paneKey, dispatchStartedAt)
    try {
      await markDispatchResult({
        runId: run.id,
        status: 'dispatched',
        workspaceId: worktree.id,
        workspaceDisplayName: worktree.displayName,
        terminalSessionId: launchedTabId,
        terminalPaneKey: result.paneKey,
        terminalPtyId: result.ptyId,
        precheckResult: resolved.context.precheckResult,
        error: null
      })
      await completion.settlePendingAfterDispatch()
    } catch (error) {
      completion.cleanupRunObservers()
      throw error
    }
    const currentState = useAppStore.getState()
    // Scheduled/Run Now dispatch stays in background; explicit row clicks alone navigate.
    if (
      focusBeforeDispatch.activeWorktreeId !== worktree.id &&
      currentState.activeWorktreeId === worktree.id
    ) {
      currentState.setActiveView(focusBeforeDispatch.activeView)
      restoreWorkspaceSelection(currentState, focusBeforeDispatch.selection)
      if (focusBeforeDispatch.activeTabId) {
        currentState.setActiveTab(focusBeforeDispatch.activeTabId)
      }
      currentState.setActiveTabType(
        focusBeforeDispatch.activeTabType,
        focusBeforeDispatch.activeWorktreeId
      )
    }
  } catch (error) {
    releaseTerminalOwnership()
    await markDispatchResult({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: resolved.context.workspaceId,
      workspaceDisplayName: resolved.context.workspaceDisplayName,
      precheckResult: resolved.context.precheckResult,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
