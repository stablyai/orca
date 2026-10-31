import type { TerminalResidentPolicyContext } from './terminal-resident-policy-context'
import { useAppStore } from '@/store'
import { isClaudeIdleEdge, idleEdgeSettledAtRest } from '@/lib/agent-idle-edge'
import { parseTerminalGitHubPRUrl } from '../../../../shared/terminal-github-pr-link-detector'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import type { createTerminalResidentTitleEffects } from './terminal-resident-title-effects'

export function createTerminalResidentAttentionCallbacks(context: TerminalResidentPolicyContext) {
  const {
    binding,
    services,
    getPtyId,
    clearSuppressedTitleSideEffects,
    shouldSuppressTitleCompletion,
    setFocusReportSuppressionForAgentCompletion,
    queueAgentIdleTerminalModeReset
  } = context
  const onWorking = () => {
    context.presentation?.clearFocusReportSuppression()
    clearSuppressedTitleSideEffects()
    if (context.notification.syncAgentTaskCompleteTrackingEnabled()) {
      context.notification.requiresFreshWorkingForAgentTaskCompleteNotification = false
      context.completion.observeTitleWorking()
    }
    services.setCacheTimerStartedAt(binding.paneKey, null)
    context.notification.clearPendingAgentTaskCompleteNotification()
    if (context.notification.pendingTerminalBellNotification) {
      context.notification.scheduleTerminalBellNotification()
    }
  }
  const onIdle = (title: string, stale = false, status?: 'idle' | 'permission') => {
    const state = useAppStore.getState()
    if (stale) {
      services.setCacheTimerStartedAt(binding.paneKey, null)
      return
    }
    const hook = state.agentStatusByPaneKey[binding.paneKey]
    if (shouldSuppressTitleCompletion(title)) {
      if (hook) {
        context.owner.preserveSuppressedTitleSideEffects(title, hook)
      }
      return
    }
    if (
      isClaudeIdleEdge(title, hook) &&
      (state.settings === null || state.settings.promptCacheTimerEnabled)
    ) {
      services.setCacheTimerStartedAt(binding.paneKey, Date.now())
    }
    if (idleEdgeSettledAtRest(title, { status })) {
      setFocusReportSuppressionForAgentCompletion(title, hook?.agentType)
    }
    if (context.notification.syncAgentTaskCompleteTrackingEnabled()) {
      context.completion.observeClassifiedTitleCompletion(title)
    }
    queueAgentIdleTerminalModeReset()
  }
  const observePrLink = (url: string) => {
    const link = parseTerminalGitHubPRUrl(url)
    if (link) {
      useAppStore.getState().observeTerminalGitHubPullRequestLink(binding.worktreeId, link, {
        tabId: binding.tabId,
        paneKey: binding.paneKey,
        ptyId: getPtyId()
      })
    }
  }
  return { onWorking, onIdle, observePrLink }
}

export function createTerminalResidentStatusCallbacks(
  context: TerminalResidentPolicyContext,
  attention: ReturnType<typeof createTerminalResidentAttentionCallbacks>,
  titleEffects: ReturnType<typeof createTerminalResidentTitleEffects>
) {
  const { binding, services, shouldSuppressTitleCompletion } = context
  const { onWorking, onIdle } = attention
  const { showTitle } = titleEffects
  const onAgentExited = () => {
    context.presentation?.onAgentExited()
    context.owner.clearSuppressedTitleSideEffects()
    context.foreground.requestKnownWindowsShiftEnterReconfirmation()
    services.setCacheTimerStartedAt(binding.paneKey, null)
    context.shellInput.clearTitleOnlyInterruptTimer()
  }
  const onTitleChange = (
    title: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ) => {
    if (!meta?.staleWorkingTitleClear && resolveCommittedTitleAgentType(rawTitle)) {
      context.foreground.paneForegroundAgentTracker.onAgentStartupObserved()
    }
    showTitle(title, rawTitle, meta?.staleWorkingTitleClear)
    if (
      !meta?.staleWorkingTitleClear &&
      context.notification.syncAgentTaskCompleteTrackingEnabled() &&
      !shouldSuppressTitleCompletion(rawTitle)
    ) {
      context.completion.observeTitle(rawTitle)
    }
  }
  const callbacks = {
    onTitleChange,
    onBell: context.notification.onBell,
    onAgentBecameWorking: onWorking,
    onAgentBecameIdle: (
      title: string,
      meta?: { staleWorkingTitleClear?: boolean; status?: 'idle' | 'permission' }
    ) => onIdle(title, meta?.staleWorkingTitleClear, meta?.status),
    onAgentExited,
    onCommandStarted: context.foreground.handleCommandStarted,
    onCommandFinished: context.foreground.handleCommandFinished,
    onCommandCodeWorking: context.commandCode.onCommandCodeWorking,
    onCommandCodeDone: context.commandCode.onCommandCodeDone,
    onAgentStatus: context.onAgentStatus,
    onMode2031Subscribe: () => context.presentation?.setMode2031(true),
    onMode2031Unsubscribe: () => context.presentation?.setMode2031(false)
  }
  return callbacks
}

export function terminalResidentSuppressesTitleCompletion(
  context: TerminalResidentPolicyContext,
  title: string
): boolean {
  return context.owner.shouldSuppressTitleCompletionForFreshHook(
    title,
    useAppStore.getState().agentStatusByPaneKey[context.binding.paneKey]
  )
}
