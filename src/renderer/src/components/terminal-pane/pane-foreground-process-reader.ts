import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import { FOREGROUND_COMMAND_READS } from '../../../../shared/foreground-command-settle'
import type { PaneForegroundAgentTrackerDeps } from './pane-foreground-agent-tracker-contract'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/runtime-terminal-stream'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { admitRemoteForegroundEvidence } from '../../../../shared/remote-foreground-evidence-admission'
import { isClientOnlyUnverifiableInspection } from '../../../../shared/terminal-process-inspection'

type ForegroundReader = (
  ptyId: string,
  options?: { expectedIncarnationId?: string }
) => Promise<string | null | RuntimeTerminalProcessInspection>

export function createPaneForegroundProcessReader(deps: {
  readForegroundProcess: ForegroundReader
  confirmForegroundProcess?: ForegroundReader
  isRemotePtyId?: (ptyId: string) => boolean
  getExpectedIncarnationId?: () => string | null
}) {
  let authorityGeneration: string | null = null
  let observationEpoch = -1
  let bindingKey: string | null = null
  const knownAuthorityGenerations = new Set<string>()

  return async (ptyId: string, requiresConfirmation: boolean) => {
    let processName: string | null = null
    let remoteEvidenceVerdict: 'live' | 'unverifiable' | 'exited' | null = null
    const expectedIncarnationId = deps.getExpectedIncarnationId?.() ?? null
    const options = expectedIncarnationId ? { expectedIncarnationId } : undefined
    const requestStartedAtMonotonic = performance.now()
    const remote = deps.isRemotePtyId?.(ptyId) === true
    if (remote) {
      const nextBindingKey = `${ptyId}\0${expectedIncarnationId ?? ''}`
      if (bindingKey !== nextBindingKey) {
        bindingKey = nextBindingKey
        authorityGeneration = null
        observationEpoch = -1
        knownAuthorityGenerations.clear()
      }
    }
    try {
      const reader = requiresConfirmation
        ? (deps.confirmForegroundProcess ?? deps.readForegroundProcess)
        : deps.readForegroundProcess
      const inspection = await (options ? reader(ptyId, options) : reader(ptyId))
      if (isClientOnlyUnverifiableInspection(inspection)) {
        // Client-only results never prove shell foreground, including local adapters whose provider disappeared.
        remoteEvidenceVerdict = 'unverifiable'
      } else if (typeof inspection === 'string' || inspection === null) {
        processName = inspection
        remoteEvidenceVerdict = remote ? 'unverifiable' : null
      } else if (remote) {
        const admitted = admitRemoteForegroundEvidence(inspection.foregroundProcessEvidence, {
          expectedPtyId:
            parseAppSshPtyId(ptyId)?.relayPtyId ?? getRemoteRuntimeTerminalHandle(ptyId) ?? ptyId,
          expectedIncarnationId,
          requestStartedAtMonotonic,
          receivedAtMonotonic: performance.now(),
          lastAuthorityGeneration: authorityGeneration,
          lastObservationEpoch: observationEpoch,
          knownAuthorityGenerations
        })
        if (admitted) {
          authorityGeneration = admitted.authorityGeneration
          observationEpoch = admitted.observationEpoch
          knownAuthorityGenerations.add(admitted.authorityGeneration)
        }
        remoteEvidenceVerdict = admitted?.verdict ?? 'unverifiable'
        if (admitted?.verdict === 'live') {
          processName = admitted.processName
        }
      } else {
        processName = inspection.foregroundProcess
      }
    } catch {
      // Missing legacy/injected-provider answers remain unverifiable remote verdicts.
      remoteEvidenceVerdict = 'unverifiable'
    }
    return {
      processName,
      remoteEvidenceVerdict,
      expectedIncarnationId,
      remote,
      recognized:
        remoteEvidenceVerdict !== null && remoteEvidenceVerdict !== 'live'
          ? null
          : recognizeAgentProcess(processName),
      shellProcess: processName !== null && isShellProcess(processName),
      wrapperProcess: processName !== null && isAgentForegroundWrapperProcess(processName)
    }
  }
}

export function shouldRetryForegroundResult(args: {
  hasConfirmationExpectation: boolean
  reason: 'command' | 'visible-pty' | 'command-finished'
  processName: string | null
  wrapperProcess: boolean
}): boolean {
  return (
    (args.hasConfirmationExpectation &&
      (args.reason !== 'command-finished' || args.processName === null)) ||
    (args.processName !== null && (args.reason === 'command' || args.wrapperProcess))
  )
}

export function foregroundResultRetryDelay(
  hasConfirmationExpectation: boolean,
  reason: 'command' | 'visible-pty' | 'command-finished',
  processName: string | null,
  wrapperProcess: boolean,
  retryIndex: number
): number | undefined {
  return shouldRetryForegroundResult({
    hasConfirmationExpectation,
    reason,
    processName,
    wrapperProcess
  })
    ? FOREGROUND_COMMAND_READS.retryDelaysMs[retryIndex]
    : undefined
}

export function createForegroundProcessExitHandler(
  deps: PaneForegroundAgentTrackerDeps,
  owner: { isCurrent: () => boolean; hasPendingRead: () => boolean; reset: () => void }
) {
  return (
    process: Parameters<NonNullable<PaneForegroundAgentTrackerDeps['onAgentProcessRead']>>[0]
  ) => {
    const published = deps.getPublishedEntry?.()
    if (
      !owner.isCurrent() ||
      (published?.agentEvidence !== 'process-read' &&
        published?.agentEvidence !== 'process-admitted') ||
      resolveCompatibleAgentTypeForOwner(process.agent, published.agent) !== published.agent
    ) {
      return
    }
    const hadVisibleRead = owner.hasPendingRead()
    owner.reset()
    deps.publish({ agent: null, shellForeground: false })
    if (hadVisibleRead) {
      deps.onVisibleForegroundSettled?.('shell')
    }
    deps.onConfirmedShellForeground?.('process-exit')
  }
}
