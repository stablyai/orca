import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import { useAppStore } from '@/store'
import { resolvePaneTitleDecision } from '../terminal-title-evidence'
import { markTerminalBracketedPasteInterrupted } from '../terminal-bracketed-paste'
import type { TerminalSemanticResident } from '../terminal-side-effect-facts-handler'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

import type { createTerminalResidentPolicy } from '../terminal-resident-policy'
import type { TerminalResidentPresentation } from '../terminal-resident-binding'
import { getTerminalSemanticResident } from '../terminal-semantic-residents'

export function installTerminalResidentPolicy(session: ConnectPanePtySession): void {
  const state = useAppStore.getState()
  const ptyId = session.deps.restoredLeafId
    ? session.deps.restoredPtyIdByLeafId?.[session.deps.restoredLeafId]
    : state.terminalLayoutsByTabId[session.deps.tabId]?.ptyIdsByLeafId?.[session.pane.leafId]
  const resident = ptyId ? getTerminalSemanticResident(ptyId) : undefined
  if (resident) {
    session.semanticResident = resident
    attachPolicyPresentation(session, resident.policy)
  }
}

export function attachTerminalResidentPresentation(
  session: ConnectPanePtySession,
  resident: TerminalSemanticResident
): () => void {
  session.detachSemanticPresentation?.()
  session.semanticResident = resident
  return attachPolicyPresentation(session, resident.policy)
}

function attachPolicyPresentation(
  session: ConnectPanePtySession,
  policy: ReturnType<typeof createTerminalResidentPolicy>
): () => void {
  session.semanticPolicy = policy
  for (const part of [policy.owner, policy.shellInput, policy.foreground, policy.notification]) {
    Object.defineProperties(session, Object.getOwnPropertyDescriptors(part))
  }
  session.terminalOwnerPolicy = policy.owner
  session.agentCompletionCoordinator = policy.completion
  session.seedCommandCodeOutputWorkingStatus = policy.commandCode.onCommandCodeWorking
  session.scheduleCommandCodeOutputDoneStatus = policy.commandCode.onCommandCodeDone
  session.clearCommandCodeOutputDoneTimer = policy.commandCode.clearDoneTimer
  session.releaseCommandCodeDoneSettleExecutor = policy.commandCode.dispose
  session.handleRendererOwnedAgentStatus = policy.callbacks.onAgentStatus
  session.onAgentBecameWorking = policy.callbacks.onAgentBecameWorking
  session.onAgentBecameIdle = policy.callbacks.onAgentBecameIdle
  session.onAgentExited = policy.callbacks.onAgentExited
  session.onTitleChange = policy.callbacks.onTitleChange
  const commandConsumer = session.commandLifecycle.attachXtermConsumer(session.pane.terminal)
  const detach = policy.attachPresentation(
    createPresentation(new WeakRef(session), session.pane.id, policy)
  )
  const detachPresentation = () => {
    commandConsumer.dispose()
    detach()
  }
  session.detachSemanticPresentation = detachPresentation
  return detachPresentation
}

function createPresentation(
  view: WeakRef<ConnectPanePtySession>,
  paneId: number,
  policy: ReturnType<typeof createTerminalResidentPolicy>
): TerminalResidentPresentation {
  return {
    paneId,
    isVisible: () => view.deref()?.deps.isVisibleRef.current === true,
    showTitle: (title, rawTitle) => {
      const session = view.deref()
      if (!session) {
        return
      }
      const decision = resolvePaneTitleDecision({
        normalizedTitle: title,
        rawTitle,
        displayOwnerAgentType: policy.shellInput.getAuthoritativePaneAgent(),
        rendererOwnerAgentType: policy.shellInput.getPaneScopedRendererOwner(),
        userGpuMode: useAppStore.getState().settings?.terminalGpuAcceleration ?? 'auto'
      })
      session.manager.setPaneGpuRendering(session.pane.id, decision.rendererPolicy.gpuEnabled)
      session.deps.setRuntimePaneTitle(session.deps.tabId, session.pane.id, decision.displayTitle)
      if (session.manager.getActivePane()?.id === session.pane.id) {
        session.deps.updateTabTitle(session.deps.tabId, decision.displayTitle)
      }
    },
    resetInputModes: () => view.deref()?.queueAgentIdleTerminalModeReset(),
    confirmedShell: () => view.deref()?.writeInputModeGround(CONFIRMED_SHELL_MODE_RESET),
    preservesSleepingRecord: (record, ptyId) => {
      const wake = view.deref()?.hibernatedWakeTarget
      return Boolean(wake && wake.record === record && (ptyId === null || wake.ptyId === ptyId))
    },
    setFocusReportSuppression: (title, agent) =>
      view.deref()?.setFocusReportSuppressionForAgentCompletion(title, agent),
    clearFocusReportSuppression: () => {
      const session = view.deref()
      if (session) {
        session.suppressNativeWindowsIdleCodexFocusReports = false
      }
    },
    markBracketedPasteInterrupted: () => {
      const terminal = view.deref()?.pane.terminal
      if (terminal) {
        markTerminalBracketedPasteInterrupted(terminal)
      }
    },
    onAgentExited: () => {
      const session = view.deref()
      if (session) {
        session.deps.onAgentExitedRef.current(session.pane.leafId)
      }
    },
    setMode2031: (subscribed) =>
      subscribed
        ? view.deref()?.handleHiddenMode2031SubscribeFact()
        : view.deref()?.handleHiddenMode2031UnsubscribeFact()
  }
}
