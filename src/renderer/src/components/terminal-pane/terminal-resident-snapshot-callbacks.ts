import type { TerminalResidentPolicyContext } from './terminal-resident-policy-context'
import { useAppStore } from '@/store'
import { detectAgentStatusFromTitle } from '../../../../shared/agent-detection'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import type { TerminalFactSubject } from './terminal-fact-subject'
import type {
  TerminalSnapshotEffect,
  TerminalTransientCurrent
} from '../../../../shared/terminal-transient-observation'
import type { createTerminalResidentTitleEffects } from './terminal-resident-title-effects'
import type {
  createTerminalResidentAttentionCallbacks,
  createTerminalResidentStatusCallbacks
} from './terminal-resident-attention-callbacks'

export function createTerminalResidentSnapshotCallbacks(
  context: TerminalResidentPolicyContext,
  titleEffects: ReturnType<typeof createTerminalResidentTitleEffects>,
  attention: ReturnType<typeof createTerminalResidentAttentionCallbacks>,
  callbacks: ReturnType<typeof createTerminalResidentStatusCallbacks>
) {
  const { binding, getPtyId, captureCommand } = context
  const { showTitle, neutralTitle } = titleEffects
  const { onWorking, onIdle } = attention
  const { onAgentExited } = callbacks
  const applyEffect = (
    effect: TerminalSnapshotEffect,
    current: TerminalTransientCurrent,
    subject?: TerminalFactSubject | null
  ): void => {
    const fact = effect.fact
    if (
      subject !== undefined &&
      !subject?.isCurrent() &&
      fact.kind !== 'bell' &&
      fact.kind !== 'pr-link'
    ) {
      if (fact.kind === 'command-finished') {
        dispatchTerminalCommandFinishedEvent(binding.worktreeId, fact.exitCode)
      }
      return
    }
    switch (fact.kind) {
      case '2031-subscribe':
      case '2031-unsubscribe':
      case 'pr-link':
      case 'program-facet':
      case 'title':
        return
      case 'command-started':
        captureCommand(effect.commandOrdinal)
        context.foreground.handleCommandStarted()
        return
      case 'command-finished':
        if (
          effect.commandOrdinal === current.commandOrdinal &&
          context.commandContext?.ordinal === effect.commandOrdinal &&
          context.commandContext.inputGeneration === context.acceptedInputGeneration
        ) {
          const command = context.commandContext
          context.foreground.finishCapturedCommand(
            fact.exitCode,
            useAppStore.getState().agentStatusByPaneKey[binding.paneKey],
            () =>
              context.isLive() &&
              context.commandContext === command &&
              context.acceptedInputGeneration === command.inputGeneration
          )
        } else if (!context.commandContext && effect.commandOrdinal === current.commandOrdinal) {
          const generation = context.acceptedInputGeneration
          context.foreground.finishCapturedCommand(
            fact.exitCode,
            useAppStore.getState().agentStatusByPaneKey[binding.paneKey],
            () =>
              context.isLive() &&
              context.commandContext === null &&
              context.acceptedInputGeneration === generation
          )
        } else {
          dispatchTerminalCommandFinishedEvent(binding.worktreeId, fact.exitCode)
        }
        return
      case 'bell':
        context.notification.onBell()
        return
      case 'agent-working':
        onWorking()
        return
      case 'agent-idle':
        onIdle(fact.title, fact.staleWorkingTitleClear, fact.status)
        return
      case 'agent-exited':
        onAgentExited()
        return
      case 'agent-status':
        context.onAgentStatus(fact.payload, effect.observedAt)
        return
      case 'command-code-working':
        context.commandCode.onCommandCodeWorking(fact.prompt)
        return
      case 'command-code-done':
        context.commandCode.onCommandCodeDone(fact.prompt)
    }
  }
  const restoreCurrent = (
    current: TerminalTransientCurrent,
    first: boolean,
    complete = true,
    subject?: TerminalFactSubject | null,
    liveEffects: readonly TerminalSnapshotEffect[] = []
  ): void => {
    if (subject !== undefined && !subject?.isCurrent()) {
      return
    }
    const title = current.title
    if (first) {
      const status =
        current.inBandStatus ??
        (current.program?.payload
          ? {
              payload: current.program.payload,
              observedAt: current.program.observedAt
            }
          : null)
      // Live companions retain their completion identity; only history may mark it handled.
      if (
        !liveEffects.some(
          ({ fact }) =>
            fact.kind === 'agent-status' ||
            fact.kind === 'agent-working' ||
            fact.kind === 'agent-idle'
        )
      ) {
        context.completion.restoreCurrent({
          title: title?.rawTitle ?? null,
          working:
            current.activity === 'working' ||
            status?.payload.state === 'working' ||
            (current.activity === null &&
              title !== null &&
              detectAgentStatusFromTitle(title.rawTitle) === 'working'),
          status: status ? { ...status.payload, stateStartedAt: status.observedAt } : null
        })
      }
      if (current.program?.payload) {
        context.onAgentStatus(current.program.payload, current.program.observedAt, true)
      }
      if (current.inBandStatus) {
        context.onAgentStatus(current.inBandStatus.payload, current.inBandStatus.observedAt, true)
      }
      if (
        !liveEffects.some(
          ({ fact }) => fact.kind === 'command-code-working' || fact.kind === 'command-code-done'
        )
      ) {
        context.commandCode.restoreCurrent(current.commandCode)
      }
      captureCommand(current.commandOrdinal)
    }
    if (title && title.rawTitle !== context.currentTitle) {
      showTitle(title.normalizedTitle, title.rawTitle, title.staleWorkingTitleClear)
    } else if (complete && !title && context.currentTitle !== null) {
      showTitle(neutralTitle())
      context.currentTitle = null
    }
    if (getPtyId() && (binding.runtimeEnvironmentId || parseRemoteRuntimePtyId(getPtyId() ?? ''))) {
      const state = useAppStore.getState()
      if (
        current.program ||
        (complete && state.agentStatusByPaneKey[binding.paneKey]?.programStatus)
      ) {
        state.setAgentProgramStatus(binding.paneKey, current.program?.facet ?? null)
      }
    }
    if (current.mode2031 !== 'unknown') {
      context.presentation?.setMode2031(current.mode2031 === 'subscribed')
    }
  }
  return { applyEffect, restoreCurrent }
}
