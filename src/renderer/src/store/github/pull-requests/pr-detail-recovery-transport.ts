import { capturePRDetailRecoveryAuthority } from './pr-detail-recovery-authority'
import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import {
  GITHUB_PR_DETAIL_RECOVERY_RUNTIME_CAPABILITY,
  PR_DETAIL_RECOVERY_WAIT_MAX_MS,
  type PRDetailRecoveryCommitArgs,
  type PRDetailRecoverySnapshot,
  type PRDetailRecoveryStartArgs
} from '../../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentCapabilityProof } from '../../../runtime/rpc/compatibility/runtime-capability-proof'

/** One host's ticket operations; native IPC and runtime RPC reach the same coordinator contract. */
export type PRDetailRecoveryTransport = {
  sourceEpoch: string
  signal?: AbortSignal
  dispose?: () => void
  start: (args: PRDetailRecoveryStartArgs) => Promise<PRDetailRecoverySnapshot>
  wait: (ticketId: string, afterRevision: number) => Promise<PRDetailRecoverySnapshot | null>
  commit: (args: PRDetailRecoveryCommitArgs) => Promise<PRDetailRecoverySnapshot | null>
  cancel: (ticketId: string) => Promise<unknown>
}

const RENDERER_SOURCE_EPOCH = `renderer:${createNonSecureContextUuid()}`
// Transport replies a little after the host's own bounded wait.
const WAIT_TIMEOUT_MS = PR_DETAIL_RECOVERY_WAIT_MAX_MS + 10_000

function nativeTransport(): PRDetailRecoveryTransport | null {
  const gh = window.api?.gh
  const start = gh?.startPRDetailRecovery
  const wait = gh?.waitPRDetailRecovery
  const commit = gh?.commitPRDetailRecovery
  const cancel = gh?.cancelPRDetailRecovery
  if (!start || !wait || !commit || !cancel) {
    return null
  }
  return {
    sourceEpoch: RENDERER_SOURCE_EPOCH,
    start: (args) => start(args),
    wait: (ticketId, afterRevision) => wait({ ticketId, afterRevision }),
    commit: (args) => commit(args),
    cancel: (ticketId) => cancel({ ticketId })
  }
}

/** Resolve once per subscription, pinned to the runtime and pairing that advertised the capability. */
export async function resolvePRDetailRecoveryTransport(
  environmentId: string | null
): Promise<PRDetailRecoveryTransport | null> {
  if (environmentId === null) {
    return nativeTransport()
  }
  const proof = await runtimeEnvironmentCapabilityProof(
    environmentId,
    GITHUB_PR_DETAIL_RECOVERY_RUNTIME_CAPABILITY
  ).catch(() => null)
  if (!proof?.supported) {
    return null
  }
  const authority = capturePRDetailRecoveryAuthority(environmentId, proof)
  const target = { kind: 'environment' as const, environmentId }
  const options = {
    signal: authority.signal,
    expectedEnvironmentRuntimeId: proof.runtimeId,
    ...(proof.pairingRevision !== undefined
      ? { expectedEnvironmentPairingRevision: proof.pairingRevision }
      : {})
  }
  return {
    signal: authority.signal,
    dispose: authority.dispose,
    sourceEpoch: `runtime:${environmentId}:${proof.runtimeId}:${proof.pairingRevision ?? ''}`,
    start: (args) =>
      callRuntimeRpc(target, 'github.prDetailRecovery.start', args, {
        ...options,
        timeoutMs: 30_000
      }),
    wait: (ticketId, afterRevision) =>
      callRuntimeRpc(
        target,
        'github.prDetailRecovery.wait',
        { ticketId, afterRevision },
        { ...options, timeoutMs: WAIT_TIMEOUT_MS }
      ),
    commit: (args) =>
      callRuntimeRpc(target, 'github.prDetailRecovery.commit', args, {
        ...options,
        timeoutMs: 30_000
      }),
    cancel: (ticketId) =>
      callRuntimeRpc(
        target,
        'github.prDetailRecovery.cancel',
        { ticketId },
        { ...options, timeoutMs: 30_000 }
      )
  }
}
