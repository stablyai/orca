import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { runtimeEnvironmentIdUnlessTwin } from '../../../lib/workspace/ownership/resolve-owner'
import { useAppStore } from '../../../store/index'
import { isCurrentSessionTabsRuntimeFrame } from '../../web-session-tabs-sync/tracking/publisher-identity-fences'
import { getRuntimeEnvironmentRevision } from '../../rpc/environment-revisions/runtime-environment-revision'

/**
 * The host admitted for one move: the runtime that proved the capability, on the pairing it was
 * asked over, serving this worktree. Every call of the move is pinned to that runtime and pairing,
 * and every local effect needs all three to still hold. A restart, re-pair or reroute hands the
 * window to the replacement host's snapshots; nothing from the old move applies.
 */
export type PaneMoveHostAuthority = {
  environmentId: string
  pairingRevision: number | undefined
  runtimeId: string
  worktreeId: string
}

/**
 * The admitted host still serves the worktree: same pairing, the worktree still routes to it, and
 * this window has not seen another runtime publish for it (a restart on the same pairing).
 */
export function isCurrentPaneMoveHost(authority: PaneMoveHostAuthority): boolean {
  return (
    getRuntimeEnvironmentRevision(authority.environmentId) === authority.pairingRevision &&
    routedEnvironmentId(authority.worktreeId) === authority.environmentId &&
    isCurrentSessionTabsRuntimeFrame(authority.environmentId, authority.runtimeId) &&
    !verifiedStatusNamesAnotherRuntime(authority)
  )
}

/** A verified status from the host can name its replacement before any replacement tab frame. */
function verifiedStatusNamesAnotherRuntime(authority: PaneMoveHostAuthority): boolean {
  const verified = lastVerifiedRuntimeStatus(
    useAppStore.getState().runtimeStatusByEnvironmentId.get(authority.environmentId)
  )?.runtimeId
  return typeof verified === 'string' && verified !== authority.runtimeId
}

export function routedEnvironmentId(worktreeId: string): string | null {
  return runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), worktreeId)
}

/** Main refuses before sending when the host's runtime or pairing no longer matches. */
export function callHost(
  authority: PaneMoveHostAuthority,
  args: { method: string; params: unknown }
): Promise<RuntimeRpcResponse<unknown>> {
  return window.api.runtimeEnvironments.call({
    selector: authority.environmentId,
    ...args,
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision: authority.pairingRevision,
    expectedEnvironmentRuntimeId: authority.runtimeId
  })
}

/** The answer came from another runtime than the admitted one, or was never sent to it. */
export function answeredByAnotherHost(
  authority: PaneMoveHostAuthority,
  response: RuntimeRpcResponse<unknown>
): boolean {
  if (!response.ok && response.error.code === 'runtime_environment_changed') {
    return true
  }
  const runtimeId = response._meta?.runtimeId
  return (
    typeof runtimeId === 'string' && runtimeId.trim() !== '' && runtimeId !== authority.runtimeId
  )
}
