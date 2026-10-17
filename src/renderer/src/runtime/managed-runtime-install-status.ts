import type { ManagedRuntimeInstallState } from '../../../shared/managed-runtime-install'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  createRevisionedHostStateStore,
  type RevisionedHostSnapshot
} from './revisioned-host-state-store'
import { callRuntimeRpc } from './runtime-rpc-client'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'

/**
 * What each host says about the runtime it installs for an agent, one entry per host runtime
 * instance and agent, so Settings and a chat read the same answer.
 */

export type ManagedRuntimeInstallSubject = {
  target: RuntimeClientTarget
  /** The paired host's runtime that answers; null for the local runtime. */
  runtimeId: string | null
  agent: string
}

export type ManagedRuntimeInstallSnapshot = RevisionedHostSnapshot<ManagedRuntimeInstallState>

const hostAgentKey = ({ target, agent }: ManagedRuntimeInstallSubject): string =>
  `${target.kind === 'local' ? '' : target.environmentId}\u0000${agent}`

const installs = createRevisionedHostStateStore<
  ManagedRuntimeInstallSubject,
  ManagedRuntimeInstallState
>({
  key: (subject) => `${hostAgentKey(subject)}\u0000${subject.runtimeId ?? ''}`,
  hostKey: hostAgentKey,
  subscribe: ({ target, agent }, handlers) =>
    subscribeRuntimeRpc(target, 'managedRuntime.subscribe', { agent }, handlers)
})

export const readManagedRuntimeInstall = installs.read
/** Subscribes while at least one shown surface observes this subject. Returns the release. */
export const observeManagedRuntimeInstall = installs.observe
/** Resubscribes a lost stream at once, e.g. when the host answers again after an outage. */
export const wakeManagedRuntimeInstall = installs.wake
export const subscribeManagedRuntimeInstalls = installs.subscribe

function callHost<T>(
  subject: ManagedRuntimeInstallSubject,
  method: 'managedRuntime.install' | 'managedRuntime.cancel' | 'managedRuntime.remove',
  params: Record<string, unknown>
): Promise<T> {
  return callRuntimeRpc<T>(
    subject.target,
    method,
    { agent: subject.agent, ...params },
    subject.runtimeId ? { expectedEnvironmentRuntimeId: subject.runtimeId } : {}
  )
}

/** Starts, or joins, the host's install; rejects with the host's refusal. */
export function installManagedRuntime(subject: ManagedRuntimeInstallSubject): Promise<void> {
  return installs.applyReply(subject, () =>
    callHost<ManagedRuntimeInstallState>(subject, 'managedRuntime.install', {})
  )
}

/** Resolves once the run has unwound; the subscription shows its outcome. */
export async function cancelManagedRuntimeInstall(
  subject: ManagedRuntimeInstallSubject,
  operationId: string
): Promise<void> {
  await callHost<unknown>(subject, 'managedRuntime.cancel', { operationId })
}

/** Starts, or joins, the host's removal; it fails, keeping the files, while anything may run them. */
export function removeManagedRuntime(subject: ManagedRuntimeInstallSubject): Promise<void> {
  return installs.applyReply(subject, () =>
    callHost<ManagedRuntimeInstallState>(subject, 'managedRuntime.remove', {})
  )
}
