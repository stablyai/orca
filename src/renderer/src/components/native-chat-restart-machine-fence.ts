import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { StructuredAgentSessionCallFence } from '@/runtime/structured-agent-session-client'

/**
 * The pairing a paired server's offer was read under. A server re-paired under the same id may be a
 * different machine, so every request on that offer is sent with it and refused before it leaves
 * if the pairing moved. A restart of the same server needs no fence: the host re-derives which
 * named chats it still offers. This computer has none.
 */
export type RestartMachineFence = Readonly<{ pairingRevision?: number }>

export function currentRestartMachineFence(target: RuntimeClientTarget): RestartMachineFence {
  const pairingRevision =
    target.kind === 'local' ? undefined : getRuntimeEnvironmentRevision(target.environmentId)
  return pairingRevision === undefined ? {} : { pairingRevision }
}

export function sameRestartMachineFence(
  left: RestartMachineFence | undefined,
  right: RestartMachineFence | undefined
): boolean {
  return left?.pairingRevision === right?.pairingRevision
}

/** The call options a fenced request carries; none for this computer, which cannot be re-paired. */
export function restartMachineCallFence(
  target: RuntimeClientTarget,
  fence: RestartMachineFence
): StructuredAgentSessionCallFence | undefined {
  if (target.kind === 'local' || fence.pairingRevision === undefined) {
    return undefined
  }
  return { expectedEnvironmentPairingRevision: fence.pairingRevision }
}
