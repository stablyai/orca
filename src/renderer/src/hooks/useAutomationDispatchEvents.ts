import { useEffect } from 'react'
import { launchAgentBackgroundSession } from '@/lib/launch-agent-background-session'
import { useAppStore } from '@/store'
import type { AutomationDispatchResult } from '../../../shared/automations-types'
import { FIRST_PANE_ID } from '../../../shared/pane-key'

const AUTOMATIONS_CHANGED_EVENT = 'orca:automations-changed'

function buildAutomationWorkspaceName(runTitle: string, scheduledFor: number): string {
  const slug = runTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const stamp = new Date(scheduledFor).toISOString().replace(/[-:]/g, '').slice(0, 13)
  return `auto-${slug || 'run'}-${stamp}`
}

export function useAutomationDispatchEvents(): void {
  useEffect(() => {
    const unsubscribe = window.api.automations.onDispatchRequested(async ({ automation, run }) => {
      const markDispatchResult = async (result: AutomationDispatchResult): Promise<void> => {
        await window.api.automations.markDispatchResult(result)
        window.dispatchEvent(new Event(AUTOMATIONS_CHANGED_EVENT))
      }
      const state = useAppStore.getState()
      const focusBeforeDispatch = {
        activeView: state.activeView,
        activeWorktreeId: state.activeWorktreeId,
        activeTabId: state.activeTabId,
        activeTabType: state.activeTabType
      }
      const repo = state.repos.find((entry) => entry.id === automation.projectId)
      let dispatchWorkspaceId = automation.workspaceId

      if (!repo) {
        await markDispatchResult({
          runId: run.id,
          status: 'skipped_unavailable',
          workspaceId: run.workspaceId,
          error: 'The target project is no longer available.'
        })
        return
      }

      if (repo.connectionId) {
        const needsPrompt = await window.api.ssh.needsPassphrasePrompt({
          targetId: repo.connectionId
        })
        if (needsPrompt) {
          await markDispatchResult({
            runId: run.id,
            status: 'skipped_needs_interactive_auth',
            workspaceId: dispatchWorkspaceId,
            error: 'SSH reconnect requires interactive credentials.'
          })
          return
        }
        const sshState = await window.api.ssh.getState({ targetId: repo.connectionId })
        if (sshState?.status !== 'connected') {
          try {
            const connected = await window.api.ssh.connect({ targetId: repo.connectionId })
            if (connected?.status !== 'connected') {
              throw new Error('SSH target is unavailable.')
            }
          } catch (error) {
            await markDispatchResult({
              runId: run.id,
              status: 'skipped_unavailable',
              workspaceId: dispatchWorkspaceId,
              error: error instanceof Error ? error.message : String(error)
            })
            return
          }
        }
      }

      try {
        const worktree =
          automation.workspaceMode === 'new_per_run'
            ? (
                await useAppStore
                  .getState()
                  .createWorktree(
                    automation.projectId,
                    buildAutomationWorkspaceName(run.title, run.scheduledFor),
                    automation.baseBranch ?? undefined,
                    'inherit',
                    undefined,
                    'unknown',
                    run.title,
                    undefined,
                    undefined,
                    undefined,
                    automation.agentId
                  )
              ).worktree
            : automation.workspaceId
              ? useAppStore
                  .getState()
                  .allWorktrees()
                  .find((entry) => entry.id === automation.workspaceId)
              : null

        if (!worktree) {
          await markDispatchResult({
            runId: run.id,
            status: 'skipped_unavailable',
            workspaceId: automation.workspaceId,
            error: 'The target workspace is no longer available.'
          })
          return
        }
        dispatchWorkspaceId = worktree.id

        let dispatchMarked = false
        let pendingExitCode: number | null = null
        let pendingDone = false
        let completionMarked = false
        let unsubscribeAgentStatus = (): void => {}
        const markCompletionResult = async (): Promise<void> => {
          if (completionMarked) {
            return
          }
          completionMarked = true
          unsubscribeAgentStatus()
          await markDispatchResult({
            runId: run.id,
            status: 'completed',
            workspaceId: worktree.id,
            error: null
          })
        }
        const markExitResult = (code: number): Promise<void> => {
          unsubscribeAgentStatus()
          return markDispatchResult({
            runId: run.id,
            status: code === 0 ? 'completed' : 'dispatch_failed',
            workspaceId: worktree.id,
            error: code === 0 ? null : `Automation process exited with code ${code}.`
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
          void markCompletionResult()
        }
        const observeAgentStatus = (tabId: string): void => {
          const paneKey = `${tabId}:${FIRST_PANE_ID}`
          const checkCurrentStatus = (): void => {
            if (useAppStore.getState().agentStatusByPaneKey[paneKey]?.state === 'done') {
              handleAgentDone()
            }
          }
          // Why: Codex/Claude completion normally arrives through the global
          // hook IPC listener, not the hidden PTY OSC fallback.
          unsubscribeAgentStatus = useAppStore.subscribe(checkCurrentStatus)
          checkCurrentStatus()
        }
        const result = await launchAgentBackgroundSession({
          agent: automation.agentId,
          worktreeId: worktree.id,
          prompt: automation.prompt,
          launchSource: 'unknown',
          title: run.title,
          onAgentStatus: (payload) => {
            if (payload.state !== 'done') {
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
            void markExitResult(code)
          }
        })
        if (!result) {
          throw new Error('Unable to build an agent launch plan.')
        }
        observeAgentStatus(result.tabId)
        try {
          await markDispatchResult({
            runId: run.id,
            status: 'dispatched',
            workspaceId: worktree.id,
            terminalSessionId: result.tabId,
            error: null
          })
          dispatchMarked = true
          if (pendingDone) {
            await markCompletionResult()
          } else if (pendingExitCode !== null) {
            await markExitResult(pendingExitCode)
          }
        } catch (error) {
          unsubscribeAgentStatus()
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
        await markDispatchResult({
          runId: run.id,
          status: 'dispatch_failed',
          workspaceId: dispatchWorkspaceId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
    void window.api.automations.rendererReady()
    return unsubscribe
  }, [])
}
