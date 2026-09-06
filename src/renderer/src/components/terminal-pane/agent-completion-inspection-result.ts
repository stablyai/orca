import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { admitRemoteForegroundEvidence } from '../../../../shared/remote-foreground-evidence-admission'
import { isClientOnlyUnverifiableInspection } from '../../../../shared/terminal-process-inspection'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/runtime-terminal-stream'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'
import type {
  AgentCompletionIdentityScope,
  LastCompletionIdentity
} from './agent-completion-identity-store'
import type { ProcessMonitorState } from './agent-completion-process-types'

export type RemoteInspectionState = {
  authorityGeneration: string | null
  observationEpoch: number
  bindingKey: string | null
  knownAuthorityGenerations: Set<string>
}

type CompletionDispatch = (
  source: 'hook' | 'title' | 'process-exit',
  title: string,
  options?: { terminalIdleConfirmed?: boolean; completionIdentity?: LastCompletionIdentity | null }
) => boolean

export function handleAgentCompletionInspectionResult(args: {
  result: RuntimeTerminalProcessInspection
  requestStartedAtMonotonic: number
  options: AgentCompletionCoordinatorOptions
  state: ProcessMonitorState
  identityScope: AgentCompletionIdentityScope
  clearAgentRunEvidence: () => void
  hasPendingHookDone: () => boolean
  hasPendingCodexAttention: () => boolean
  scheduleNextPoll: () => void
  handleRecognizedProcess: (process: RecognizedAgentProcess) => void
  dispatchCompletion: CompletionDispatch
  remoteInspection: RemoteInspectionState
}): boolean {
  const {
    result,
    requestStartedAtMonotonic,
    options,
    state,
    identityScope,
    clearAgentRunEvidence,
    hasPendingHookDone,
    hasPendingCodexAttention,
    scheduleNextPoll,
    handleRecognizedProcess,
    dispatchCompletion,
    remoteInspection
  } = args
  if (isClientOnlyUnverifiableInspection(result)) {
    state.pendingProcessExitAgent = null
    state.consecutiveInspectionErrors += 1
    scheduleNextPoll()
    return false
  }
  const remote = options.isRemotePtyId?.(options.getPtyId() ?? '') === true
  if (remote) {
    const evidence = result.foregroundProcessEvidence
    // Remote identity is host-authoritative. Compatibility names and unverifiable observations
    // never mutate routing state or synthesize process exit.
    const expectedIncarnationId = options.getExpectedIncarnationId?.() ?? null
    const ptyId = options.getPtyId()
    const bindingKey = `${ptyId ?? ''}\0${expectedIncarnationId ?? ''}`
    if (remoteInspection.bindingKey !== bindingKey) {
      remoteInspection.bindingKey = bindingKey
      remoteInspection.authorityGeneration = null
      remoteInspection.observationEpoch = -1
      remoteInspection.knownAuthorityGenerations.clear()
    }
    const expectedRemotePtyId = (id: string): string =>
      parseAppSshPtyId(id)?.relayPtyId ?? getRemoteRuntimeTerminalHandle(id) ?? id
    const admitted = admitRemoteForegroundEvidence(evidence, {
      expectedPtyId: ptyId ? expectedRemotePtyId(ptyId) : '',
      expectedIncarnationId,
      requestStartedAtMonotonic,
      receivedAtMonotonic: performance.now(),
      lastAuthorityGeneration: remoteInspection.authorityGeneration,
      lastObservationEpoch: remoteInspection.observationEpoch,
      knownAuthorityGenerations: remoteInspection.knownAuthorityGenerations
    })
    if (!admitted) {
      state.pendingProcessExitAgent = null
      state.consecutiveInspectionErrors += 1
      return false
    }
    remoteInspection.authorityGeneration = admitted.authorityGeneration
    remoteInspection.observationEpoch = admitted.observationEpoch
    remoteInspection.knownAuthorityGenerations.add(admitted.authorityGeneration)
    if (admitted.verdict === 'exited') {
      const exited = state.lastForegroundAgent
      if (exited && state.hasAgentRunEvidence) {
        if (options.shouldSuppressConfirmedProcessExitCompletion?.(exited) !== true) {
          dispatchCompletion('process-exit', exited.processName, {
            terminalIdleConfirmed: true,
            completionIdentity: {
              source: 'process-exit',
              identity: `${exited.agent}:${exited.processName}`,
              agentIdentity: exited.agent
            }
          })
        }
      }
      state.lastForegroundAgent = null
      clearAgentRunEvidence()
      return false
    }
    if (admitted.verdict !== 'live') {
      state.pendingProcessExitAgent = null
      return false
    }
    state.consecutiveInspectionErrors = 0
    if (admitted.processName === null) {
      state.pendingProcessExitAgent = null
      return false
    }
    const recognizedRemote = recognizeAgentProcess(admitted.processName)
    if (!recognizedRemote) {
      state.pendingProcessExitAgent = null
      return false
    }
    handleRecognizedProcess(recognizedRemote)
    return true
  }
  state.consecutiveInspectionErrors = 0
  const recognized = recognizeAgentProcess(result.foregroundProcess)
  if (recognized) {
    handleRecognizedProcess(recognized)
    return true
  }
  if (hasPendingHookDone() || hasPendingCodexAttention()) {
    scheduleNextPoll()
    return false
  }
  if (state.lastForegroundAgent && state.hasAgentRunEvidence) {
    if (result.hasChildProcesses) {
      state.pendingProcessExitAgent = null
      scheduleNextPoll()
      return false
    }
    const pending = state.pendingProcessExitAgent
    if (
      !pending ||
      pending.agent !== state.lastForegroundAgent.agent ||
      pending.processName !== state.lastForegroundAgent.processName
    ) {
      state.pendingProcessExitAgent = state.lastForegroundAgent
      scheduleNextPoll()
      return false
    }
    const exited = state.lastForegroundAgent
    state.pendingProcessExitAgent = null
    if (options.shouldSuppressConfirmedProcessExitCompletion?.(exited) !== true) {
      const replayIdentityBeforeExit = identityScope.getLast()
      const committed = dispatchCompletion('process-exit', exited.processName, {
        terminalIdleConfirmed: true,
        completionIdentity: {
          source: 'process-exit',
          identity: `${exited.agent}:${exited.processName}`,
          agentIdentity: exited.agent
        }
      })
      if (
        !committed &&
        !identityScope.hasUnconsumedStampedTail() &&
        replayIdentityBeforeExit?.source === 'hook' &&
        replayIdentityBeforeExit.agentIdentity === exited.agent
      ) {
        identityScope.deleteLast()
      }
    }
    state.lastForegroundAgent = null
    clearAgentRunEvidence()
  } else {
    state.lastForegroundAgent = null
    clearAgentRunEvidence()
  }
  return false
}
