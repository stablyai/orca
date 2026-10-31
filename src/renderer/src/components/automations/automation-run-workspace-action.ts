import { openExistingStructuredSession } from '@/lib/open-existing-structured-session'
import { ALL_TUI_AGENTS } from '../../../../shared/tui-agent-display-names'
import { isStructuredAgentSessionIdFor } from '../../../../shared/structured-agent-session-create'
import type { AutomationRun } from '../../../../shared/automations-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  activateAndRevealWorktree,
  activateAndRevealFolderWorkspace
} from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { activateTerminalTabOnOwner } from '@/lib/terminal-tab-owner-activation'
import { activateWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildAutomationRunOpenLayout } from './automation-run-open-target'
import type { AutomationsPageActionContext } from './automations-page-action-context'

let cancelPendingReveal: (() => void) | undefined

/** Opens the recorded run session when its host-qualified workspace is alive. */
export function createAutomationRunWorkspaceAction({
  list
}: {
  list: Pick<AutomationsPageActionContext['list'], 'runTargetFor'>
}) {
  function revealRunWorkspace(run: AutomationRun, ownerOpened = false): void {
    const appStore = useAppStore.getState()
    const {
      worktree: runWorktree,
      ownerEnvironmentId,
      expectedPairingRevision,
      terminalTarget,
      viewState: runViewState
    } = list.runTargetFor(run)
    const currentLayout = terminalTarget
      ? appStore.terminalLayoutsByTabId[terminalTarget.tabId]
      : null
    if (!run.workspaceId || !runViewState.canOpen) {
      toast.error(runViewState.statusLabel)
      return
    }
    const paneRef = parsePaneKey(run.terminalPaneKey ?? '')
    if (!runWorktree) {
      if (ownerEnvironmentId && paneRef) {
        const workspaceId = run.workspaceId
        const navigation = () => {
          const state = useAppStore.getState()
          return [
            state.activeWorktreeId,
            state.activeWorkspaceExecutionHostId,
            state.activeModal,
            state.activeWorktreeId
              ? resolveWebSessionVisibleTabId(state, state.activeWorktreeId)
              : null
          ]
        }
        const origin = navigation()
        let cancelled = false
        const cancel = () => {
          cancelled = true
        }
        cancelPendingReveal = cancel
        const current = () =>
          !cancelled &&
          navigation().every((value, index) => value === origin[index]) &&
          list.runTargetFor(run).viewState.canOpen
        const unsubscribe = useAppStore.subscribe(() => {
          if (!current()) {
            cancel()
          }
        })
        void (async () => {
          try {
            if (
              !(await openRunTerminalOnOwner(
                workspaceId,
                ownerEnvironmentId,
                paneRef,
                expectedPairingRevision
              )) ||
              !current()
            ) {
              return
            }
            await appStore.fetchRuntimeEnvironmentRepos(ownerEnvironmentId)
            if (!current()) {
              return
            }
            await appStore.fetchAllWorktrees({
              visibilityOwnerHostId: `runtime:${encodeURIComponent(ownerEnvironmentId)}`
            })
            if (!current()) {
              return
            }
            if (list.runTargetFor(run).worktree) {
              revealRunWorkspace(run, true)
            } else {
              toast.error(workspaceUnavailableMessage())
            }
          } catch {
            if (current()) {
              toast.error(workspaceUnavailableMessage())
            }
          } finally {
            unsubscribe()
            if (cancelPendingReveal === cancel) {
              cancelPendingReveal = undefined
            }
          }
        })()
      }
      return
    }
    const reveal = () => {
      const options = {
        executionHostId: runWorktree.hostId,
        runtimeEnvironmentId: ownerEnvironmentId,
        providesInitialSurface:
          runViewState.availability === 'terminal' || runViewState.availability === 'chat'
      }
      const scope = parseWorkspaceKey(run.workspaceId!)
      return scope?.type === 'folder' && runViewState.availability !== 'terminal'
        ? activateAndRevealFolderWorkspace(scope.folderWorkspaceId, options)
        : activateAndRevealWorktree(run.workspaceId!, options)
    }
    if (runViewState.availability === 'chat' && run.chatSessionId) {
      const agent = ALL_TUI_AGENTS.find((entry) =>
        isStructuredAgentSessionIdFor(entry, run.chatSessionId!)
      )
      if (!agent || !reveal()) {
        toast.error(workspaceUnavailableMessage())
        return
      }
      void openRunChat(run.workspaceId, run.chatSessionId, ownerEnvironmentId)
      return
    }
    if (runViewState.availability === 'terminal' && !terminalTarget) {
      if (!ownerEnvironmentId || !paneRef) {
        toast.error(runViewState.statusLabel)
        return
      }
      if (!reveal()) {
        toast.error(workspaceUnavailableMessage())
        return
      }
      // Why: the mirror may not hold the pane yet; the server focuses it when it arrives.
      if (!ownerOpened) {
        void openRunTerminalOnOwner(
          run.workspaceId,
          ownerEnvironmentId,
          paneRef,
          expectedPairingRevision
        )
      }
      return
    }
    if (terminalTarget && currentLayout) {
      appStore.setTabLayout(
        terminalTarget.tabId,
        buildAutomationRunOpenLayout({ target: terminalTarget, currentLayout })
      )
      if (reveal()) {
        appStore.setActiveTab(terminalTarget.tabId)
        appStore.setActiveTabType('terminal', run.workspaceId)
        if (!ownerOpened) {
          activateTerminalTabOnOwner(
            run.workspaceId,
            terminalTarget.tabId,
            terminalTarget.leafId,
            ownerEnvironmentId,
            expectedPairingRevision
          )
        }
        return
      }
    }
    if (!reveal()) {
      toast.error(workspaceUnavailableMessage())
      return
    }
    toast.message(runViewState.statusLabel)
  }
  return (run: AutomationRun): void => {
    cancelPendingReveal?.()
    revealRunWorkspace(run)
  }
}

async function openRunChat(
  worktreeId: string,
  sessionId: string,
  environmentId: string | null
): Promise<void> {
  try {
    await openExistingStructuredSession(
      { workspaceId: worktreeId, sessionId },
      {
        target: environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
        present: (outcome) => {
          if (outcome !== 'activated') {
            runChatUnavailable()
          }
        },
        onError: runChatUnavailable
      }
    )
  } catch {
    // The initiating interaction owns error feedback, including when this click joins it.
  }
}

function runChatUnavailable(): void {
  toast.message(
    translate(
      'components.automations.runChatUnavailable',
      'Run chat is unavailable. Showing its workspace; any saved output remains in Run Details.'
    )
  )
}

function workspaceUnavailableMessage(): string {
  return translate(
    'auto.components.automations.AutomationsPage.e1bf9b1512',
    'Workspace is not available.'
  )
}

async function openRunTerminalOnOwner(
  worktreeId: string,
  environmentId: string,
  paneRef: { tabId: string; leafId: string },
  expectedPairingRevision?: number
): Promise<boolean> {
  const opened = await activateWebRuntimeSessionTab({
    worktreeId,
    tabId: paneRef.tabId,
    environmentId,
    leafId: paneRef.leafId,
    expectedPairingRevision,
    expectedCurrentLocalTabId: resolveWebSessionVisibleTabId(useAppStore.getState(), worktreeId)
  })
  if (!opened) {
    toast.error(
      translate('components.automations.runTerminalUnavailable', 'Run terminal is unavailable.')
    )
  }
  return opened
}

export type AutomationRunWorkspaceAction = ReturnType<typeof createAutomationRunWorkspaceAction>
