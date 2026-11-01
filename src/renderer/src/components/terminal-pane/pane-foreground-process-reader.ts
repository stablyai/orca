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
      remote
    }
  }
}
