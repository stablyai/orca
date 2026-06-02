/* eslint-disable max-lines -- Why: automation dispatch is a single renderer lifecycle
 * coordinator spanning workspace creation, SSH readiness, terminal launch/reuse,
 * completion bookkeeping, and focus restoration. */
import { useEffect } from 'react'
import { launchAgentBackgroundSession } from '@/lib/launch-agent-background-session'
import { submitPromptToAgentTab } from '@/lib/agent-paste-draft'
import { findReusableAutomationSession } from '@/lib/automation-session-reuse'
import { observeExistingAutomationSession } from '@/lib/automation-session-observer'
import {
  getStartupCommandTitle,
  resolveGlobalStartupCommandTarget,
  resolveTrustedGlobalStartupCommandCwd,
  resolveTerminalCommandLaunchTarget,
  resolveStartupCommandTargets
} from '@/lib/automation-startup-command-targets'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { useAppStore } from '@/store'
import type {
  AutomationDispatchResult,
  AutomationPrecheckResult
} from '../../../shared/automations-types'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../../shared/automation-precheck'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  createAutomationRunOutputSnapshotBuffer,
  selectAutomationRunOutputSnapshot
} from '@/components/automations/automation-run-output-snapshot'

const AUTOMATIONS_CHANGED_EVENT = 'orca:automations-changed'
const activeReuseDispatchTabIds = new Set<string>()

// Why: track whether we've already revealed the floating workspace for global
// startup commands on this session so we only open it once.
let globalStartupFloatingRevealed = false

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
      const automationWorktree = automation.workspaceId
        ? state.allWorktrees().find((entry) => entry.id === automation.workspaceId)
        : null
      let dispatchWorkspaceId = automation.workspaceId
      let dispatchWorkspaceDisplayName =
        automationWorktree?.displayName ?? run.workspaceDisplayName ?? null
      let precheckResult: AutomationPrecheckResult | null = null

      if (!repo && automation.scope !== 'global') {
        await markDispatchResult({
          runId: run.id,
          status: 'skipped_unavailable',
          workspaceId: run.workspaceId,
          workspaceDisplayName: run.workspaceDisplayName ?? null,
          error: 'The target project is no longer available.'
        })
        return
      }

      if (repo?.connectionId) {
        const needsPrompt = await window.api.ssh.needsPassphrasePrompt({
          targetId: repo.connectionId
        })
        if (needsPrompt) {
          await markDispatchResult({
            runId: run.id,
            status: 'skipped_needs_interactive_auth',
            workspaceId: dispatchWorkspaceId,
            workspaceDisplayName: dispatchWorkspaceDisplayName,
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
              workspaceDisplayName: dispatchWorkspaceDisplayName,
              error: error instanceof Error ? error.message : String(error)
            })
            return
          }
        }
      }

      if (
        automation.scope !== 'global' &&
        automation.workspaceMode === 'existing' &&
        !automationWorktree &&
        (automation.action !== 'terminal_command' ||
          automation.launchTarget === 'selected_worktree')
      ) {
        await markDispatchResult({
          runId: run.id,
          status: 'skipped_unavailable',
          workspaceId: automation.workspaceId,
          workspaceDisplayName: dispatchWorkspaceDisplayName,
          error: 'The target workspace is no longer available.'
        })
        return
      }

      if (automation.action === 'terminal_command') {
        const command = automation.command?.trim() || automation.prompt.trim()
        if (!command) {
          await markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            workspaceId: dispatchWorkspaceId,
            workspaceDisplayName: dispatchWorkspaceDisplayName,
            error: 'Automation command is empty.'
          })
          return
        }
        const stateBeforeLaunch = useAppStore.getState()
        const duplicateTitle =
          run.trigger === 'app_launch' ? getStartupCommandTitle(automation.name) : null
        const globalTarget =
          automation.scope === 'global' &&
          (automation.launchTarget === 'floating' || !automation.projectId)
            ? resolveGlobalStartupCommandTarget({
                globalCwd: automation.globalCwd,
                tabsByWorktree: stateBeforeLaunch.tabsByWorktree,
                duplicateTitle
              })
            : null
        const targets = globalTarget
          ? [globalTarget]
          : resolveStartupCommandTargets({
              projectId: automation.projectId,
              launchTarget: resolveTerminalCommandLaunchTarget({
                runTrigger: run.trigger,
                automationTrigger: automation.trigger ?? 'schedule',
                automationLaunchTarget: automation.launchTarget ?? 'selected_worktree'
              }),
              worktrees: stateBeforeLaunch.allWorktrees(),
              tabsByWorktree: stateBeforeLaunch.tabsByWorktree,
              selectedWorktreeId: automation.workspaceId,
              duplicateTitle
            })
        if (targets.length === 0) {
          await markDispatchResult({
            runId: run.id,
            status: duplicateTitle ? 'skipped_duplicate' : 'skipped_unavailable',
            workspaceId: dispatchWorkspaceId,
            workspaceDisplayName: dispatchWorkspaceDisplayName,
            error: duplicateTitle
              ? 'Startup command already has a terminal for each target.'
              : 'No target workspace is available.'
          })
          return
        }
        let launched: {
          worktree: (typeof targets)[number]
          worktreeId: string
          tab: { id: string }
        }[]
        try {
          launched = await Promise.all(
            targets.map(async (worktree) => {
              const cwd =
                'cwd' in worktree
                  ? resolveTrustedGlobalStartupCommandCwd({
                      configuredCwd: worktree.cwd,
                      resolvedCwd: await window.api.app.getFloatingTerminalCwd({
                        path: worktree.cwd,
                        requireTrusted: true
                      })
                    })
                  : undefined
              if ('cwd' in worktree && !cwd) {
                throw new Error('Global startup command directory is no longer trusted.')
              }
              const store = useAppStore.getState()
              const worktreeId = 'worktreeId' in worktree ? worktree.worktreeId : worktree.id
              const tab = store.createTab(worktreeId, undefined, undefined, {
                activate: false,
                recordInteraction: false
              })
              store.queueTabStartupCommand(tab.id, { command, ...(cwd ? { cwd } : {}) })
              store.setTabCustomTitle(tab.id, duplicateTitle ?? automation.name, {
                recordInteraction: false
              })
              return { worktree, worktreeId, tab }
            })
          )
        } catch (error) {
          await markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            workspaceId: dispatchWorkspaceId,
            workspaceDisplayName: dispatchWorkspaceDisplayName,
            error: error instanceof Error ? error.message : String(error)
          })
          return
        }
        const first = launched[0]
        // Why: a startup command can fan out to several worktrees, but the
        // run history has one workspace slot. Use the first launched target
        // as the representative row; duplicate protection tracks every tab.
        await markDispatchResult({
          runId: run.id,
          status: 'dispatched',
          workspaceId: first.worktreeId,
          workspaceDisplayName: first.worktree.displayName,
          terminalSessionId: first.tab.id,
          error: null
        })
        // Why: reveal the floating workspace so the user sees their global
        // startup command terminals. Only open once per session to avoid
        // toggling the panel closed on subsequent dispatches.
        if (
          automation.launchTarget === 'floating' &&
          automation.scope === 'global' &&
          !globalStartupFloatingRevealed
        ) {
          globalStartupFloatingRevealed = true
          window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
        }
        return
      }

      if ((run.trigger === 'scheduled' || run.trigger === 'app_launch') && automation.precheck) {
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
              ? automationWorktree
              : null

        if (!worktree) {
          await markDispatchResult({
            runId: run.id,
            status: 'skipped_unavailable',
            workspaceId: automation.workspaceId,
            workspaceDisplayName: dispatchWorkspaceDisplayName,
            error: 'The target workspace is no longer available.'
          })
          return
        }
        dispatchWorkspaceId = worktree.id
        dispatchWorkspaceDisplayName = worktree.displayName

        const outputSnapshotBuffer = createAutomationRunOutputSnapshotBuffer()
        let latestAssistantMessage: string | null = null
        const getOutputSnapshot = () =>
          selectAutomationRunOutputSnapshot(latestAssistantMessage, outputSnapshotBuffer.snapshot())
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
          await markDispatchResult({
            runId: run.id,
            status: 'completed',
            workspaceId: worktree.id,
            workspaceDisplayName: worktree.displayName,
            outputSnapshot: getOutputSnapshot(),
            precheckResult,
            error: null
          })
        }
        const markExitResult = (code: number): Promise<void> => {
          cleanupRunObservers()
          return markDispatchResult({
            runId: run.id,
            status: code === 0 ? 'completed' : 'dispatch_failed',
            workspaceId: worktree.id,
            workspaceDisplayName: worktree.displayName,
            outputSnapshot: getOutputSnapshot(),
            precheckResult,
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
        const observeAgentStatus = (
          tabId: string,
          startedAfter: number,
          options?: { requireWorkingAfterStart?: boolean }
        ): void => {
          let sawWorkingAfterStart = false
          const checkCurrentStatus = (): void => {
            const { agentStatusByPaneKey } = useAppStore.getState()
            for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
              const parsed = parsePaneKey(paneKey)
              if (parsed?.tabId !== tabId || entry.updatedAt < startedAfter) {
                continue
              }
              if (entry.state === 'working') {
                sawWorkingAfterStart = true
              }
              if (
                entry.state === 'done' &&
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
            runs: await window.api.automations.listRuns({ automationId: automation.id }),
            state: useAppStore.getState()
          })
          if (reusableSession) {
            const releaseTab = acquireReuseDispatchTab(reusableSession.tabId)
            if (releaseTab) {
              releaseReuseDispatchTab = releaseTab
              try {
                const submitted = await submitPromptToAgentTab({
                  tabId: reusableSession.tabId,
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
                      void markExitResult(code)
                    }
                  })
                  observeAgentStatus(reusableSession.tabId, reuseCompletionStartedAt, {
                    requireWorkingAfterStart: true
                  })
                  await markDispatchResult({
                    runId: run.id,
                    status: 'dispatched',
                    workspaceId: worktree.id,
                    workspaceDisplayName: worktree.displayName,
                    terminalSessionId: reusableSession.tabId,
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
            latestAssistantMessage = payload.lastAssistantMessage?.trim() || latestAssistantMessage
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
        observeAgentStatus(result.tabId, dispatchStartedAt)
        try {
          await markDispatchResult({
            runId: run.id,
            status: 'dispatched',
            workspaceId: worktree.id,
            workspaceDisplayName: worktree.displayName,
            terminalSessionId: result.tabId,
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
        await markDispatchResult({
          runId: run.id,
          status: 'dispatch_failed',
          workspaceId: dispatchWorkspaceId,
          workspaceDisplayName: dispatchWorkspaceDisplayName,
          precheckResult,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
    let rendererReadySent = false
    const sendRendererReady = (): void => {
      if (rendererReadySent) {
        return
      }
      rendererReadySent = true
      void window.api.automations.rendererReady()
    }
    const unsubscribeWorkspaceReady = useAppStore.subscribe((state) => {
      if (state.workspaceSessionReady) {
        sendRendererReady()
      }
    })
    if (useAppStore.getState().workspaceSessionReady) {
      sendRendererReady()
    }
    return () => {
      unsubscribeWorkspaceReady()
      unsubscribe()
    }
  }, [])
}
