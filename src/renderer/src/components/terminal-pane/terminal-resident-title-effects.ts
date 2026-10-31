import { foregroundAgentForActions } from '../../../../shared/agent-status-identity'
import { canCommandCodeOutputOwnPane } from './command-code-output-ownership'
import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import type { createTerminalCommandCodeStatusPolicy } from './terminal-command-code-status-policy'
import type { TerminalResidentPolicyContext } from './terminal-resident-policy-context'
import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  neutralTerminalTitle,
  titleAfterConfirmedShell,
  titleAfterInferredInterrupt
} from '../../../../shared/terminal-pane-title-reset'
import {
  getSleepingRecordForPane,
  clearSleepingRecordProviderDuplicates
} from './terminal-sleeping-records'
import { isRemoteExecutionHostPtyId } from '../../../../shared/remote-execution-host-pty-id'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { TerminalForegroundServices } from './pty-connection/terminal-foreground-services'

export function createTerminalResidentTitleEffects(context: TerminalResidentPolicyContext) {
  const { binding, getPtyId } = context
  const tab = () =>
    (useAppStore.getState().tabsByWorktree[binding.worktreeId] ?? []).find(
      (candidate) => candidate.id === binding.tabId
    )
  const neutralTitle = () => neutralTerminalTitle(tab()?.defaultTitle)
  const showTitle = (title: string, raw = title, stale = false) => {
    context.currentTitle = raw
    if (context.presentation) {
      context.presentation.showTitle(title, raw, stale)
      return
    }
    const state = useAppStore.getState()
    if (context.displayPaneId !== null) {
      state.setRuntimePaneTitle(binding.tabId, context.displayPaneId, title)
    }
    const layout = state.terminalLayoutsByTabId[binding.tabId]
    if (
      layout?.activeLeafId === parsePaneKey(binding.paneKey)?.leafId ||
      (!layout && (state.ptyIdsByTabId[binding.tabId] ?? []).length === 1)
    ) {
      state.updateTabTitle(binding.tabId, title)
    }
  }
  const resetAgentTitle = (confirmed: boolean) => {
    const title = confirmed
      ? titleAfterConfirmedShell(context.currentTitle, neutralTitle())
      : titleAfterInferredInterrupt(context.currentTitle, neutralTitle())
    if (title !== null) {
      showTitle(title)
    }
  }
  const onConfirmedShellForeground: TerminalForegroundServices['onConfirmedShellForeground'] = (
    reason
  ) => {
    const state = useAppStore.getState()
    const sleeping = getSleepingRecordForPane(state, {
      ...binding,
      paneId: context.displayPaneId ?? undefined
    })
    const ptyId = getPtyId()
    const isHibernationWakeRecord =
      (ptyId && state.suppressedPtyExitIds[ptyId]) ||
      (sleeping && context.presentation?.preservesSleepingRecord?.(sleeping.record, ptyId))
    if (sleeping && !isHibernationWakeRecord) {
      clearSleepingRecordProviderDuplicates(state, sleeping)
    }
    resetAgentTitle(true)
    context.presentation?.confirmedShell?.()
    if (!isHibernationWakeRecord) {
      context.presentation?.onAgentExited?.()
    }
    if (reason === 'visible-pty' || reason === 'process-exit') {
      useAppStore.getState().clearAgentLaunchConfig(binding.paneKey)
    }
  }
  const onForegroundAgentExited = (exited: RecognizedAgentProcess) => {
    context.foreground.paneForegroundAgentTracker.onProcessExitConfirmed(exited)
    const entry = useAppStore.getState().agentStatusByPaneKey[binding.paneKey]
    if (
      isRemoteExecutionHostPtyId(context.identity?.ptyId) ||
      !entry ||
      resolveCompatibleAgentTypeForOwner(entry.agentType, exited.agent) !== exited.agent ||
      context.foreground.deferredCommandFinishedStatusDrop
    ) {
      return
    }
    const sequence = entry.acceptedStatusSeq
    context.foreground.deferredCommandFinishedStatusDrop = () =>
      context.input.dropCommandFinishedStatusIfSameTurn(entry)
    context.foreground.deferredConfirmedShellReconcile = () =>
      context.foreground.reconcileEndedProcessIfPaneQuiet(sequence)
    context.foreground.settleDeferredCommandFinishedStatusDrop({ processExitConfirmed: true })
  }
  return {
    neutralTitle,
    showTitle,
    resetAgentTitle,
    onConfirmedShellForeground,
    onForegroundAgentExited
  }
}

export function terminalResidentCommandCodeOptions(
  context: TerminalResidentPolicyContext
): Parameters<typeof createTerminalCommandCodeStatusPolicy>[0] {
  const { binding, getPtyId } = context
  return {
    paneKey: binding.paneKey,
    resolveRouting: () =>
      resolveLiveAgentStatusConnectionRouting({
        state: useAppStore.getState(),
        paneKey: binding.paneKey,
        ptyId: getPtyId(),
        expectedConnectionId: getConnectionIdFromState(useAppStore.getState(), binding.worktreeId)
      }),
    canApply: () => {
      const state = useAppStore.getState()
      const paneForeground = state.paneForegroundAgentByPaneKey[binding.paneKey]
      return canCommandCodeOutputOwnPane({
        foregroundAgent: foregroundAgentForActions(paneForeground),
        shellForeground: paneForeground?.shellForeground,
        paneOwnerAgent: context.shellInput.getAuthoritativePaneAgent(),
        retainedPaneOwnerAgent: state.retainedAgentsByPaneKey[binding.paneKey]?.agentType
      })
    },
    readTitle: () => context.currentTitle ?? undefined
  }
}
