import type { RuntimeCapabilityProof } from '../../../runtime/rpc/compatibility/runtime-capability-proof'
import {
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from '../../../runtime/rpc/environment-revisions/runtime-environment-revision'

/** A known authority loss retires this grant, even if an earlier response is still in transit. */
export function capturePRDetailRecoveryAuthority(
  environmentId: string,
  proof: RuntimeCapabilityProof
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const revoke = (): void => controller.abort()
  const changed = (ids: readonly string[]): void => {
    if (ids.includes(environmentId)) {
      revoke()
    }
  }
  const retired = onRuntimeEnvironmentsRetired(changed)
  const revised = onRuntimeEnvironmentRevisionsChanged(changed)
  const status = window.api.runtimeEnvironments.onStatusChanged?.((snapshot) => {
    if (
      snapshot.environmentId === environmentId &&
      (snapshot.retired ||
        snapshot.verification === 'blocked' ||
        (proof.pairingRevision !== undefined &&
          snapshot.pairingRevision !== proof.pairingRevision) ||
        (snapshot.status && snapshot.status.runtimeId !== proof.runtimeId))
    ) {
      revoke()
    }
  })
  return {
    signal: controller.signal,
    dispose: () => {
      retired()
      revised()
      status?.()
    }
  }
}

/** Release the renderer grant as soon as its captured authority is lost. */
export function onPRDetailRecoveryAuthorityLost(
  transport: { signal?: AbortSignal; dispose?: () => void },
  revoke: () => void
): boolean {
  const { signal, dispose } = transport
  transport.dispose = () => {
    signal?.removeEventListener('abort', revoke)
    dispose?.()
  }
  signal?.addEventListener('abort', revoke, { once: true })
  if (signal?.aborted) {
    revoke()
    return true
  }
  return false
}
