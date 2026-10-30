import type { TerminalAttachmentLaunchResult } from '../../../../shared/terminal-attachment-launch-result'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'
import { TERMINAL_SIDE_EFFECT_STATE_CAPABILITY } from '../../../../shared/terminal-transient-observation'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  RemoteRuntimePtyRecoveryState,
  registerRemoteRuntimePtyControlReadyReviver
} from './remote-runtime-pty-recovery-state'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import type { TerminalSemanticResident } from './terminal-semantic-residents'
import { retireCapturedResident } from './terminal-semantic-residents'

export async function remoteTerminalNeedsLegacySource(ptyId: string): Promise<boolean> {
  const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
  return (
    environmentId !== null &&
    environmentId !== undefined &&
    !(await runtimeEnvironmentSupportsCapability(
      environmentId,
      TERMINAL_SIDE_EFFECT_STATE_CAPABILITY
    ))
  )
}

/** Older hosts keep a live-tail reader owned by the execution, including while no view exists. */
export function subscribeResidentRemoteSource(
  ptyId: string,
  admit: (result?: TerminalAttachmentLaunchResult) => TerminalSemanticResident
): () => void {
  const endpoint = parseRemoteRuntimePtyId(ptyId)?.environmentId
  if (!endpoint) {
    return () => {}
  }
  let resident: TerminalSemanticResident | undefined
  let disposed = false
  const isLive = () => !disposed && (!resident || resident.isLive)
  const revision = getRuntimeEnvironmentRevision(endpoint)
  const recovery = new RemoteRuntimePtyRecoveryState()
  let unsubscribe: (() => void) | undefined
  const reconnect = (epoch: number): void => {
    if (!isLive() || !recovery.ownsEpoch(epoch)) {
      return
    }
    if (
      resolveContinuedRuntimeEnvironmentRevision(endpoint, revision) !==
      getRuntimeEnvironmentRevision(endpoint)
    ) {
      return
    }
    unsubscribe?.()
    unsubscribe = undefined
    void subscribeToRuntimeTerminalData(
      ptyId,
      `desktop:semantic:${ptyId}`,
      (data, meta) => {
        if (isLive() && resident?.isLive && recovery.ownsEpoch(epoch)) {
          resident.policy.observeLegacyData(data, meta)
        }
      },
      {
        startAtLiveTail: true,
        onAdmitted: (result) => {
          if (
            !isLive() ||
            !recovery.ownsEpoch(epoch) ||
            resolveContinuedRuntimeEnvironmentRevision(endpoint, revision) !==
              getRuntimeEnvironmentRevision(endpoint)
          ) {
            return
          }
          resident = admit(result)
        },
        onSnapshot: () => {},
        onEnd: (verdict) => {
          if (!isLive() || !recovery.ownsEpoch(epoch)) {
            return
          }
          if (verdict === 'exited') {
            if (resident) {
              retireCapturedResident(resident)
            }
          } else {
            retry(epoch)
          }
        },
        onTransportClose: () => retry(epoch)
      }
    )
      .then((close) => {
        if (!isLive() || !recovery.ownsEpoch(epoch) || recovery.currentPhase !== 'recovering') {
          close()
        } else {
          unsubscribe = close
          recovery.markHealthy()
        }
      })
      .catch((error: unknown) => {
        if (!isLive()) {
          return
        }
        console.warn('[terminal-status] Could not follow remote terminal output:', error)
        retry(epoch)
      })
  }
  const retry = (epoch: number): void => {
    if (!isLive() || !recovery.ownsEpoch(epoch)) {
      return
    }
    if (recovery.currentPhase === 'disconnected') {
      recovery.parkRetryAfterDeadline(reconnect)
      return
    }
    resident?.policy.foreground.paneForegroundAgentTracker.suspend()
    const next = recovery.isActive ? epoch : recovery.begin()
    recovery.schedule(next, reconnect)
  }
  const revive = () => {
    if (!isLive() || recovery.currentPhase !== 'disconnected') {
      return false
    }
    return recovery.retryNow()
  }
  const releaseReviver = registerRemoteRuntimePtyControlReadyReviver(endpoint, revive)
  reconnect(recovery.begin())
  return () => {
    disposed = true
    recovery.dispose()
    releaseReviver()
    unsubscribe?.()
  }
}
