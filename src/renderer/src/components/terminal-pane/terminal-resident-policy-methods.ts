import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'
import { captureTerminalFactSubject, type TerminalFactSubject } from './terminal-fact-subject'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { useAppStore } from '@/store'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import type { TerminalResidentBinding, TerminalResidentServices } from './terminal-resident-binding'
import type { TerminalResidentPolicyContext } from './terminal-resident-policy-context'
import type { TerminalResidentPolicy } from './terminal-resident-registry'
import type { TerminalResidentLegacySource } from './terminal-resident-legacy-source'
import type { createTerminalResidentStatusCallbacks } from './terminal-resident-attention-callbacks'
import { captureNotificationTransportOwner } from '@/attention/notification-subject-owner'
import type { TerminalResidentPresentation } from './terminal-resident-binding'
import type { AgentInterruptInputIntent } from '../../../../shared/agent-interrupt-intent'
import { isPassiveTerminalInputReport } from './terminal-passive-input-report'
import type { PtyTransport } from './pty-transport-types'
import type { PtyDataMeta } from './pty-dispatcher'

type SnapshotCallbacks = Pick<
  TerminalResidentPolicy,
  'restoreCurrent' | 'applyEffect' | 'observePrLink'
>

export function terminalResidentLegacyCallbacks(
  context: TerminalResidentPolicyContext,
  callbacks: SnapshotCallbacks
): ConstructorParameters<typeof TerminalResidentLegacySource>[1] {
  const { isLive } = context
  const { restoreCurrent, applyEffect, observePrLink } = callbacks
  return {
    restoreCurrent: (current, first, complete, subject) => {
      if (isLive()) {
        restoreCurrent(current, first, complete, subject)
      }
    },
    applyEffect: (effect, current, subject) => {
      if (!isLive()) {
        return
      }
      applyEffect(effect, current, subject)
    },
    observePrLink: (url) => {
      if (isLive()) {
        observePrLink(url)
      }
    },
    dispose: () => {}
  }
}

export function createTerminalResidentPolicyMethods(
  context: TerminalResidentPolicyContext,
  methods: SnapshotCallbacks & {
    bindPty: (ptyId: string, incarnationId: string | null, runtimeId?: string | null) => boolean
    callbacks: ReturnType<typeof createTerminalResidentStatusCallbacks>
    legacySource: TerminalResidentLegacySource
  }
) {
  const { binding, getPtyId, isLive } = context
  const { bindPty, callbacks, restoreCurrent, legacySource, applyEffect, observePrLink } = methods
  return {
    callbacks,
    recordInputDispatch(): void {
      context.acceptedInputGeneration += 1
    },
    acceptInput(data: string, intent: AgentInterruptInputIntent | null = null): void {
      if (!isLive() || isPassiveTerminalInputReport(data)) {
        return
      }
      if (intent === null) {
        context.acceptedInputGeneration += 1
      }
      context.shellInput.observeAcceptedShellCommandInput(data)
    },
    binding,
    bindPty,
    attachTransport(value: PtyTransport): void {
      if (!context.identity) {
        context.transport = value
      }
      context.workspaceOwner = captureNotificationTransportOwner(value)
    },
    getPtyId,
    isLive,
    owner: context.owner,
    shellInput: context.shellInput,
    input: context.input,
    foreground: context.foreground,
    completion: context.completion,
    notification: context.notification,
    commandCode: context.commandCode,
    attachPresentation(port: TerminalResidentPresentation): () => void {
      const detach = context.presentationPorts.attach(port)
      context.displayPaneId = port.paneId
      if (context.currentTitle !== null && context.currentTitle !== binding.initialTitle) {
        port.showTitle(context.currentTitle, context.currentTitle)
      }
      return detach
    },
    restoreCurrent,
    legacySource,
    observeRetainedFacts(batch: TerminalSideEffectBatch, original: TerminalFactSubject): void {
      let subject = original
      for (const fact of batch.facts) {
        const current = subject.isCurrent()
        if (current || fact.kind === 'bell' || fact.kind === 'pr-link') {
          legacySource.observeFacts({ ...batch, facts: [fact] }, subject)
          if (current) {
            subject = captureTerminalFactSubject(binding.paneKey)
          }
        } else if (fact.kind === 'command-finished') {
          dispatchTerminalCommandFinishedEvent(binding.worktreeId, fact.exitCode)
        }
      }
    },
    observeLegacyData(
      data: string,
      meta?: PtyDataMeta,
      subject?: TerminalFactSubject | null
    ): void {
      if (!isLive()) {
        return
      }
      context.completion.observeOutputActivity()
      legacySource.observeData(data, meta, subject)
    },
    applyEffect,
    observePrLink,
    dispose(): void {
      context.foreground.publication.clear()
      context.ended = true
      context.transport = undefined
      context.presentationPorts.clear()
      legacySource.dispose()
      context.unsubscribeSettings()
      context.releaseRendererOwner?.()
      context.owner.unregisterAgentHookTerminalLifecycle()
      context.shellInput.clearTitleOnlyInterruptTimer()
      context.input.clearPendingTerminalInputIntent()
      context.input.dispose()
      context.foreground.commandLifecycle.dispose()
      context.foreground.paneForegroundAgentTracker.dispose()
      context.completion.dispose()
      context.commandCode.dispose()
      context.notification.clearPendingAgentTaskCompleteNotification()
      context.notification.clearTerminalBellNotificationTimer()
    }
  }
}

export function terminalResidentServices(
  binding: TerminalResidentBinding
): TerminalResidentServices {
  return {
    setCacheTimerStartedAt: (paneKey, startedAt) =>
      useAppStore.getState().setCacheTimerStartedAt(paneKey, startedAt),
    markTerminalBell: (event) => useAppStore.getState().markTerminalBell(event),
    dispatchNotification: (event) => dispatchTerminalNotification(binding.worktreeId, event)
  }
}
