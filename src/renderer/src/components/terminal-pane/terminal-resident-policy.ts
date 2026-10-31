import {
  createTerminalResidentPolicyMethods,
  terminalResidentServices,
  terminalResidentLegacyCallbacks
} from './terminal-resident-policy-methods'
import type { TerminalResidentPolicyContext } from './terminal-resident-policy-context'
import {
  createTerminalResidentTitleEffects,
  terminalResidentCommandCodeOptions
} from './terminal-resident-title-effects'
import {
  createTerminalResidentAttentionCallbacks,
  createTerminalResidentStatusCallbacks,
  terminalResidentSuppressesTitleCompletion
} from './terminal-resident-attention-callbacks'
import { createTerminalResidentSnapshotCallbacks } from './terminal-resident-snapshot-callbacks'
import { TerminalResidentLegacySource } from './terminal-resident-legacy-source'
import { TerminalResidentPresentations } from './terminal-resident-presentations'
import { createTerminalResidentStatusObserver } from './terminal-resident-status-observer'
import { registerRendererOwnedAgentStatusPane } from './renderer-owned-agent-status-registry'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

import { createTerminalOwnerPolicy } from './pty-connection/terminal-owner-policy'
import { createTerminalShellInputPolicy } from './pty-connection/terminal-shell-input-policy'

import { useAppStore } from '@/store'
import { resolveInitialTerminalResidentOwner } from './terminal-resident-binding'

import type { AgentType } from '../../../../shared/agent-status-types'

import { createTerminalInputPolicy } from './pty-connection/terminal-input-policy'
import { createTerminalForegroundPolicy } from './pty-connection/pane-agent-identity'
import { createTerminalNotificationPolicy } from './pty-connection/terminal-notification-policy'
import { createTerminalCompletionPolicy } from './pty-connection/terminal-completion-policy'
import { createTerminalCommandCodeStatusPolicy } from './terminal-command-code-status-policy'
import { subscribeAgentTaskCompleteTrackingEnabled } from './pty-connection/agent-task-complete-settings'
import type { TerminalResidentIdentity } from './terminal-resident-registry'

import type { PtyTransport } from './pty-transport-types'

import type { TerminalResidentBinding, TerminalResidentServices } from './terminal-resident-binding'
export type { TerminalResidentBinding, TerminalResidentServices } from './terminal-resident-binding'

/** Store policy survives presentation loss; all async callbacks keep this captured execution. */
export function createTerminalResidentPolicy(
  binding: TerminalResidentBinding,
  initialIdentity: Readonly<TerminalResidentIdentity> | null,
  executionIsLive: () => boolean,
  services: TerminalResidentServices = terminalResidentServices(binding)
) {
  let identity: TerminalResidentPolicyContext['identity'] = initialIdentity
  let transport: PtyTransport | undefined
  let workspaceOwner = resolveInitialTerminalResidentOwner(binding, initialIdentity)
  let ended = false
  const isLive = () => !ended && executionIsLive()
  const presentationPorts = new TerminalResidentPresentations()
  let currentTitle: string | null = binding.initialTitle ?? null
  let displayPaneId: number | null = null
  let acceptedInputGeneration = 0
  let commandContext: TerminalResidentPolicyContext['commandContext'] = null
  const captureCommand = (ordinal: number) => {
    commandContext = {
      ordinal,
      inputGeneration: acceptedInputGeneration,
      entry: useAppStore.getState().agentStatusByPaneKey[binding.paneKey]
    }
  }
  const getPtyId = () => (isLive() ? (identity?.ptyId ?? transport?.getPtyId() ?? null) : null)
  const clearSuppressedTitleSideEffects = () => owner.clearSuppressedTitleSideEffects()
  const queueAgentIdleTerminalModeReset = () => presentationPorts.current?.resetInputModes()
  const setFocusReportSuppressionForAgentCompletion = (
    title: string | undefined,
    agentType: AgentType | undefined
  ) => presentationPorts.current?.setFocusReportSuppression(title, agentType)
  const context: TerminalResidentPolicyContext = {
    binding,
    services,
    getPtyId,
    isLive,
    captureCommand,
    clearSuppressedTitleSideEffects,
    shouldSuppressTitleCompletion: (title) =>
      terminalResidentSuppressesTitleCompletion(context, title),
    setFocusReportSuppressionForAgentCompletion,
    queueAgentIdleTerminalModeReset,
    get transport() {
      return transport
    },
    set transport(value) {
      transport = value
    },
    set workspaceOwner(value) {
      workspaceOwner = value
    },
    set ended(value) {
      ended = value
    },
    presentationPorts,
    set displayPaneId(value) {
      displayPaneId = value
    },
    set acceptedInputGeneration(value) {
      acceptedInputGeneration = value
    },
    get unsubscribeSettings() {
      return unsubscribeSettings
    },
    get releaseRendererOwner() {
      return releaseRendererOwner
    },
    get identity() {
      return identity
    },
    get presentation() {
      return presentationPorts.current
    },
    get currentTitle() {
      return currentTitle
    },
    set currentTitle(value) {
      currentTitle = value
    },
    get displayPaneId() {
      return displayPaneId
    },
    get acceptedInputGeneration() {
      return acceptedInputGeneration
    },
    get commandContext() {
      return commandContext
    },
    get owner() {
      return owner
    },
    get shellInput() {
      return shellInput
    },
    get input() {
      return input
    },
    get foreground() {
      return foreground
    },
    get notification() {
      return notification
    },
    get completion() {
      return completion
    },
    get commandCode() {
      return commandCode
    },
    get onAgentStatus() {
      return onAgentStatus
    }
  }
  const titleEffects = createTerminalResidentTitleEffects(context)
  const { showTitle, neutralTitle, resetAgentTitle } = titleEffects
  const owner = createTerminalOwnerPolicy({
    setCacheTimerStartedAt: services.setCacheTimerStartedAt,
    ...binding,
    setFocusReportSuppressionForAgentCompletion,
    queueAgentIdleTerminalModeReset,
    clearFocusReportSuppression: () => presentationPorts.current?.clearFocusReportSuppression()
  })
  const shellInput = createTerminalShellInputPolicy({
    ...binding,
    startup: binding.startup ?? null,
    owner,
    readTitle: () => currentTitle,
    showTitle,
    neutralTerminalTitle: neutralTitle,
    requestAcceptedInputDiscovery: () => foreground.requestAcceptedInputDiscovery()
  })
  const input = createTerminalInputPolicy({
    paneKey: binding.paneKey,
    isLive,
    clearInferredInterruptWorkingTitle: () => resetAgentTitle(false),
    observeTitleOnlyInterrupt: shellInput.observeTitleOnlyInterrupt,
    markBracketedPasteInterrupted: () => presentationPorts.current?.markBracketedPasteInterrupted()
  })
  const foreground = createTerminalForegroundPolicy({
    ...binding,
    startup: binding.startup ?? null,
    getPtyId,
    getExpectedIncarnationId: () => identity?.incarnationId ?? null,
    execution: executionIsLive,
    endpoint: initialIdentity?.endpoint,
    executionHost: initialIdentity?.executionHost,
    getInputGeneration: () => acceptedInputGeneration,
    isLive,
    isVisible: () => presentationPorts.current?.isVisible() === true,
    observeForegroundAgentProcess: (process) => completion.observeForegroundAgentProcess(process),
    flushPendingInterruptInference: input.flushPendingInterruptInference,
    dropCommandFinishedStatusIfSameTurn: input.dropCommandFinishedStatusIfSameTurn,
    onConfirmedShellForeground: titleEffects.onConfirmedShellForeground
  })
  const notification = createTerminalNotificationPolicy({
    ...binding,
    getWorkspaceOwner: () => workspaceOwner,
    getPtyId,
    isLive,
    hasPendingHookDoneCompletion: () => completion.hasPendingHookDoneCompletion(),
    markTerminalBell: services.markTerminalBell,
    dispatchNotification: services.dispatchNotification
  })
  const completion = createTerminalCompletionPolicy({
    ...binding,
    getPtyId,
    getExpectedIncarnationId: () => identity?.incarnationId ?? null,
    isLive,
    isVisible: () => presentationPorts.current?.isVisible() === true,
    clearSuppressedTitleSideEffects,
    setFocusReportSuppressionForAgentCompletion,
    queueAgentIdleTerminalModeReset,
    scheduleAgentTaskCompleteNotification: notification.scheduleAgentTaskCompleteNotification,
    absorbBurstBellForHookOwnedIdle: notification.absorbBurstBellForHookOwnedIdle,
    captureForegroundRead: foreground.publication.captureRead,
    onForegroundAgentExited: titleEffects.onForegroundAgentExited
  })
  if (binding.initialTitle) {
    completion.seedTitle(binding.initialTitle)
  }
  const commandCode = createTerminalCommandCodeStatusPolicy(
    terminalResidentCommandCodeOptions(context)
  )
  const unsubscribeSettings = subscribeAgentTaskCompleteTrackingEnabled(() => {
    if (notification.syncAgentTaskCompleteTrackingEnabled()) {
      completion.startProcessTracking()
    }
  })
  const attention = createTerminalResidentAttentionCallbacks(context)
  const { observePrLink } = attention
  let releaseRendererOwner: (() => void) | undefined
  const bindPty = (
    ptyId: string,
    incarnationId: string | null,
    runtimeId?: string | null
  ): boolean => {
    if (
      ended ||
      (identity &&
        (identity.ptyId !== ptyId ||
          (identity.incarnationId !== null &&
            incarnationId !== null &&
            identity.incarnationId !== incarnationId)))
    ) {
      return false
    }
    identity = Object.freeze({
      ptyId,
      incarnationId: incarnationId ?? identity?.incarnationId ?? null,
      runtimeId: runtimeId ?? identity?.runtimeId ?? null
    })
    const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
    if (environmentId && !releaseRendererOwner) {
      releaseRendererOwner = registerRendererOwnedAgentStatusPane(binding.paneKey, environmentId)
    }
    transport = undefined
    completion.startProcessTracking()
    return true
  }
  if (initialIdentity) {
    bindPty(initialIdentity.ptyId, initialIdentity.incarnationId, initialIdentity.runtimeId)
  }
  const onAgentStatus = createTerminalResidentStatusObserver({
    binding,
    getPtyId,
    readTitle: () => currentTitle,
    shellInput,
    notification,
    completion
  })
  const callbacks = createTerminalResidentStatusCallbacks(context, attention, titleEffects)
  const { applyEffect, restoreCurrent } = createTerminalResidentSnapshotCallbacks(
    context,
    titleEffects,
    attention,
    callbacks
  )
  const legacySource = new TerminalResidentLegacySource(
    binding,
    terminalResidentLegacyCallbacks(context, { restoreCurrent, applyEffect, observePrLink })
  )
  completion.startProcessTracking()
  return createTerminalResidentPolicyMethods(context, {
    bindPty,
    callbacks,
    restoreCurrent,
    legacySource,
    applyEffect,
    observePrLink
  })
}
