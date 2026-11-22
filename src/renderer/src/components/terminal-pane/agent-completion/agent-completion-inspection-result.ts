import {
  type RecognizedAgentProcess,
  recognizeAgentProcess
} from '../../../../../shared/agent-status/process/agent-process-recognition'
import { parseAppSshPtyId } from '../../../../../shared/remote-runtime/ssh/ssh-pty-id'
import { admitRemoteForegroundEvidence } from '../../../../../shared/terminal/pty/foreground/remote-foreground-evidence-admission'
import {
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection as RuntimeTerminalProcessInspection
} from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'

import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'
import type {
  AgentCompletionIdentityScope,
  LastCompletionIdentity
} from './agent-completion-identity-store'
import type { ProcessMonitorState } from './agent-completion-process-types'
import type { CadenceFollowUp } from './agent-completion-poll-scheduler'
import { isShellProcess } from '../../../../../shared/agent-status/process/shell-process-detection'
import { POLL_TIER_INTERVAL_MS } from './agent-completion-poll-cadence'

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

const WSL_LAUNCHER_RE = /(?:^|[\\/])wsl(?:\.exe)?$/i

/** The pane's own shell at rest: a listed shell, a login shell (`-zsh`), or the `wsl.exe` launcher whose Linux side Windows reads cannot see. */
function isPaneShell(processName: string): boolean {
  const name = processName.trim().replace(/^-/, '')
  return isShellProcess(name) || WSL_LAUNCHER_RE.test(name)
}

// Two foreground misses can span one process handoff; only sustained absence confirms exit.
const LOCAL_PROCESS_EXIT_SETTLE_MS = POLL_TIER_INTERVAL_MS.active * 2

export function handleAgentCompletionInspectionResult(args: {
  result: RuntimeTerminalProcessInspection
  requestStartedAtMonotonic: number
  options: AgentCompletionCoordinatorOptions
  state: ProcessMonitorState
  identityScope: AgentCompletionIdentityScope
  clearAgentRunEvidence: () => void
  hasPendingHookDone: () => boolean
  requestFollowUp: (kind: CadenceFollowUp) => void
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
    requestFollowUp,
    handleRecognizedProcess,
    dispatchCompletion,
    remoteInspection
  } = args
  const remote = options.isRemotePtyId?.(options.getPtyId() ?? '') === true
  if (
    isClientOnlyUnverifiableInspection(result) ||
    (!remote && result.childProcessEvidence === 'unverifiable')
  ) {
    state.pendingProcessExit = null
    state.consecutiveInspectionErrors += 1
    requestFollowUp('error')
    return false
  }
  if (remote) {
    state.commandInForeground = false
    const evidence = result.foregroundProcessEvidence
    // Only authoritative remote evidence may change routing or synthesize exit; legacy names and unverifiable reads cannot.
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
      state.pendingProcessExit = null
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
      if (exited) {
        options.onForegroundAgentExited?.(exited)
      }
      return false
    }
    if (admitted.verdict !== 'live') {
      state.pendingProcessExit = null
      return false
    }
    state.consecutiveInspectionErrors = 0
    if (admitted.processName === null) {
      state.pendingProcessExit = null
      return false
    }
    const recognizedRemote = recognizeAgentProcess(admitted.processName)
    if (!recognizedRemote) {
      state.pendingProcessExit = null
      return false
    }
    handleRecognizedProcess(recognizedRemote)
    return true
  }
  state.consecutiveInspectionErrors = 0
  const recognized = recognizeAgentProcess(result.foregroundProcess)
  const exitNoticed =
    result.foregroundExitWatched === true && options.receivesForegroundExitNotices?.() !== false
  state.commandInForeground =
    !recognized &&
    result.foregroundProcess !== null &&
    (!isPaneShell(result.foregroundProcess) || result.childProcessEvidence === 'children')
  if (recognized) {
    handleRecognizedProcess(recognized)
    // Without the host's exit notice a silent exit has no event, so keep the slow re-check that caught it.
    // A watched pid also settles a cached name the child census contradicts: its exit is the notice.
    if (!exitNoticed) {
      requestFollowUp('unresolved')
    }
    return true
  }
  if (hasPendingHookDone()) {
    requestFollowUp('pending')
    return false
  }
  if (state.lastForegroundAgent && state.hasAgentRunEvidence) {
    if (result.hasChildProcesses) {
      state.pendingProcessExit = null
      // A background child can outlive the agent silently, so keep reading until it settles.
      requestFollowUp('unresolved')
      return false
    }
    const pending = state.pendingProcessExit
    if (
      !pending ||
      pending.process.agent !== state.lastForegroundAgent.agent ||
      pending.process.processName !== state.lastForegroundAgent.processName
    ) {
      state.pendingProcessExit = {
        process: state.lastForegroundAgent,
        firstObservedAtMonotonic: performance.now()
      }
      requestFollowUp('pending')
      return false
    }
    if (performance.now() - pending.firstObservedAtMonotonic <= LOCAL_PROCESS_EXIT_SETTLE_MS) {
      requestFollowUp('pending')
      return false
    }
    const exited = state.lastForegroundAgent
    state.pendingProcessExit = null
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
    options.onForegroundAgentExited?.(exited)
    if (state.commandInForeground) {
      requestFollowUp('unresolved')
    }
  } else {
    state.lastForegroundAgent = null
    clearAgentRunEvidence()
    // A command, or a shell with children (Windows names only the shell), can start an agent silently
    // (`npm run agent`), and no OS event reports a new child.
    if (state.commandInForeground) {
      requestFollowUp('unresolved')
    }
  }
  return false
}
