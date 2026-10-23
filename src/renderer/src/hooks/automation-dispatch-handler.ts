import { translate } from '@/i18n/i18n'
import { launchAgentBackgroundSession } from '@/lib/launch-agent-background-session'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'
import { useAppStore } from '@/store'
import { captureWorkspaceSelection, restoreWorkspaceSelection } from '@/lib/active-workspace-host'
import { hasExtraAgentArgs } from '../../../shared/automation-extra-agent-args'
import type {
  AutomationDispatchRequest,
  AutomationDispatchResult
} from '../../../shared/automations-types'
import { createAutomationDispatchCompletion } from './automation-dispatch-completion'
import {
  launchStructuredAutomationSession,
  tryDispatchReusableAutomationSession
} from './automation-dispatch-structured-session'
import {
  prepareAutomationDispatchWorkspace,
  resolveAutomationDispatchWorkspace
} from './automation-dispatch-workspace'

export async function handleAutomationDispatchRequest({
  automation,
  run,
  dispatchToken
}: AutomationDispatchRequest): Promise<void> {
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
    if (automation.reuseSession && !hasExtraAgentArgs(automation.extraAgentArgs)) {
      const reused = await tryDispatchReusableAutomationSession({
        automation,
        run,
        worktree,
        precheckResult: resolved.context.precheckResult,
        completion,
        markDispatchResult
      })
      if (reused) {
        return
      }
    }
    const structuredResult = await launchStructuredAutomationSession({
      automation,
      run,
      worktreeId: worktree.id
    })
    if (structuredResult) {
      completion.observeAgentStatus(structuredResult.paneKey, dispatchStartedAt)
      try {
        await markDispatchResult({
          runId: run.id,
          status: 'dispatched',
          workspaceId: worktree.id,
          workspaceDisplayName: worktree.displayName,
          sessionKind: 'structured',
          chatSessionId: structuredResult.chatSessionId,
          terminalSessionId: structuredResult.tabId,
          terminalPaneKey: structuredResult.paneKey,
          terminalPtyId: null,
          precheckResult: resolved.context.precheckResult,
          error: null
        })
        await completion.settlePendingAfterDispatch()
      } catch (error) {
        completion.cleanupRunObservers()
        throw error
      }
      restoreFocusAfterDispatch(focusBeforeDispatch, worktree.id)
      return
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
      // Why: the first fresh launch is the seed for later reuse and must
      // survive completion under the same policy as an already-reused tab.
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
    restoreFocusAfterDispatch(focusBeforeDispatch, worktree.id)
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

function restoreFocusAfterDispatch(
  focusBeforeDispatch: {
    activeView: ReturnType<typeof useAppStore.getState>['activeView']
    activeWorktreeId: string | null
    selection: ReturnType<typeof captureWorkspaceSelection>
    activeTabId: string | null
    activeTabType: ReturnType<typeof useAppStore.getState>['activeTabType']
  },
  worktreeId: string
): void {
  const currentState = useAppStore.getState()
  // Why: Run Now and scheduled dispatches should create workspaces/tabs in
  // the background; only an explicit row click should navigate there.
  if (
    focusBeforeDispatch.activeWorktreeId !== worktreeId &&
    currentState.activeWorktreeId === worktreeId
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
}
